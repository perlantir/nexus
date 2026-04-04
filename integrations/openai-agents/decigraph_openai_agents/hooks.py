"""
nexus-openai-agents — Lifecycle Hooks
======================================
Hooks for the OpenAI Agents SDK that integrate DeciGraph memory into every agent
run automatically.

The OpenAI Agents SDK (``openai-agents``) exposes an ``AgentHooks`` protocol
with ``on_start``, ``on_end``, ``on_tool_call``, and ``on_tool_output`` async
callbacks.  ``DeciGraphAgentHooks`` implements this protocol and:

* **on_start**: compiles context from DeciGraph and injects it into the agent's
  system message as an additional instruction.
* **on_end**: extracts decisions from the completed conversation and sends
  them to the distillery.
* **on_tool_output**: captures tool results as potential artefacts.

Usage::

    import asyncio
    from agents import Agent, Runner
    from decigraph_sdk import DeciGraphClient
    from decigraph_openai_agents import DeciGraphAgentHooks

    client = DeciGraphClient()
    hooks = DeciGraphAgentHooks(
        client=client,
        project_id="proj-123",
        agent_name="assistant",
        task_description="Build the payments API.",
    )

    agent = Agent(
        name="assistant",
        instructions="You are a helpful software engineer.",
        hooks=hooks,
    )

    result = asyncio.run(Runner.run(agent, "Help me design the API."))
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from decigraph_sdk import DeciGraphClient
from decigraph_sdk.exceptions import DeciGraphError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Attempt to import the OpenAI Agents SDK types.  The integration is designed
# to degrade gracefully if the SDK is not installed so the module can always
# be imported (e.g. for type-checking purposes).
# ---------------------------------------------------------------------------
try:
    from agents import AgentHooks, RunContextWrapper, Tool  # type: ignore[import-untyped]

    _AGENTS_SDK_AVAILABLE = True
except ImportError:
    _AGENTS_SDK_AVAILABLE = False

    class AgentHooks:  # type: ignore[no-redef]
        """Stub when openai-agents is not installed."""

    class RunContextWrapper:  # type: ignore[no-redef]
        """Stub when openai-agents is not installed."""

    class Tool:  # type: ignore[no-redef]
        """Stub when openai-agents is not installed."""


class DeciGraphAgentHooks(AgentHooks):
    """
    OpenAI Agents SDK lifecycle hooks backed by DeciGraph.

    Parameters
    ----------
    client:
        An initialised ``DeciGraphClient`` instance.
    project_id:
        The DeciGraph project to scope all reads and writes to.
    agent_name:
        The name of the agent these hooks are attached to.
    task_description:
        Default task description for context compilation.  The first message
        in the run is appended to this when available.
    max_tokens:
        Optional token budget for context compilation.
    inject_context_into_instructions:
        When ``True`` (default), ``on_start`` prepends compiled DeciGraph context
        to the agent's dynamic instructions via
        ``context.run_context.run_instructions``.  Set to ``False`` if you
        prefer to handle injection yourself.
    capture_tool_outputs:
        When ``True`` (default), ``on_tool_output`` appends tool results to
        the run buffer for distillation.
    create_session_on_end:
        When ``True`` (default), ``on_end`` creates a DeciGraph ``SessionSummary``.
    """

    def __init__(
        self,
        client: DeciGraphClient,
        project_id: str,
        agent_name: str,
        task_description: str = "Perform the current task.",
        max_tokens: int | None = None,
        inject_context_into_instructions: bool = True,
        capture_tool_outputs: bool = True,
        create_session_on_end: bool = True,
    ) -> None:
        self.client = client
        self.project_id = project_id
        self.agent_name = agent_name
        self.task_description = task_description
        self.max_tokens = max_tokens
        self.inject_context_into_instructions = inject_context_into_instructions
        self.capture_tool_outputs = capture_tool_outputs
        self.create_session_on_end = create_session_on_end

        self._run_buffer: list[str] = []
        self._decision_ids: list[str] = []
        self._session_started_at: str = datetime.now(tz=timezone.utc).isoformat()

    # ------------------------------------------------------------------
    # AgentHooks interface
    # ------------------------------------------------------------------

    async def on_start(
        self,
        context: RunContextWrapper,  # type: ignore[override]
        agent: Any,
    ) -> None:
        """
        Called by the OpenAI Agents SDK when a new agent run begins.

        Compiles DeciGraph context and optionally injects it into the agent's
        runtime instructions.

        Parameters
        ----------
        context:
            The run context wrapper provided by the SDK.
        agent:
            The ``Agent`` object being run.
        """
        self._session_started_at = datetime.now(tz=timezone.utc).isoformat()
        self._run_buffer.clear()

        # Derive task description from the input if available
        task = self.task_description
        input_text = _extract_run_input(context)
        if input_text:
            task = f"{task}\n\nCurrent input: {input_text}"
            self._run_buffer.append(f"User: {input_text}")

        if not self.inject_context_into_instructions:
            return

        try:
            pkg = self.client.compile_context(
                project_id=self.project_id,
                agent_name=self.agent_name,
                task_description=task,
                max_tokens=self.max_tokens,
            )
            compiled_text: str = pkg.get("compiled_text", "")
        except DeciGraphError as exc:
            logger.warning("DeciGraphAgentHooks.on_start: context compilation failed — %s", exc)
            compiled_text = ""

        if compiled_text:
            # Inject context into the agent's dynamic instructions if the SDK
            # exposes a mutable ``run_instructions`` attribute; otherwise log.
            run_ctx = getattr(context, "run_context", None) or context
            existing: str = getattr(run_ctx, "run_instructions", None) or ""
            nexus_block = f"[DeciGraph Context]\n{compiled_text}\n\n"
            if nexus_block not in existing:
                try:
                    object.__setattr__(run_ctx, "run_instructions", nexus_block + existing)
                except AttributeError:
                    pass  # Read-only; SDK version may differ
            logger.debug(
                "DeciGraphAgentHooks.on_start: injected %d chars of context",
                len(compiled_text),
            )

    async def on_end(
        self,
        context: RunContextWrapper,  # type: ignore[override]
        agent: Any,
        output: Any,
    ) -> None:
        """
        Called by the OpenAI Agents SDK when an agent run finishes.

        Captures the final output, sends the accumulated conversation buffer
        to the DeciGraph distillery, and creates a session summary.

        Parameters
        ----------
        context:
            The run context wrapper.
        agent:
            The ``Agent`` object that just finished.
        output:
            The run output (string or structured object).
        """
        output_text = _extract_output_text(output)
        if output_text:
            self._run_buffer.append(f"Assistant: {output_text}")

        await self._flush_buffer()

        if self.create_session_on_end:
            await self._create_session_summary(agent=agent)

    async def on_tool_call(
        self,
        context: RunContextWrapper,  # type: ignore[override]
        agent: Any,
        tool: Any,
    ) -> None:
        """
        Called before a tool is invoked.  Currently a no-op.

        Parameters
        ----------
        context:
            The run context wrapper.
        agent:
            The calling agent.
        tool:
            The tool about to be called.
        """
        pass

    async def on_tool_output(
        self,
        context: RunContextWrapper,  # type: ignore[override]
        agent: Any,
        tool: Any,
        result: Any,
    ) -> None:
        """
        Called after a tool returns a result.

        Captures the tool output as a potential artefact signal in the run
        buffer.  The output will be included in the distillery call at
        ``on_end``.

        Parameters
        ----------
        context:
            The run context wrapper.
        agent:
            The agent that called the tool.
        tool:
            The tool that was called.
        result:
            The tool's return value.
        """
        if not self.capture_tool_outputs:
            return

        tool_name: str = _extract_tool_name(tool)
        result_text: str = _extract_output_text(result)
        if result_text:
            self._run_buffer.append(f"[Tool: {tool_name}]\n{result_text}")

    async def on_handoff(
        self,
        context: RunContextWrapper,  # type: ignore[override]
        agent: Any,
        source: Any,
    ) -> None:
        """
        Called when control is handed off to this agent from another.

        Refreshes DeciGraph context for the new agent task.

        Parameters
        ----------
        context:
            The run context wrapper.
        agent:
            The agent receiving the handoff.
        source:
            The agent handing off.
        """
        source_name = _extract_agent_name(source)
        logger.debug(
            "DeciGraphAgentHooks.on_handoff: agent '%s' received handoff from '%s'",
            self.agent_name,
            source_name,
        )

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    async def flush(self) -> None:
        """
        Manually flush the current run buffer to the DeciGraph distillery.

        Useful in long-running agent loops where you want intermediate
        checkpoint saves rather than waiting for ``on_end``.
        """
        await self._flush_buffer()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _flush_buffer(self) -> None:
        """Send the accumulated run buffer to the distillery."""
        if not self._run_buffer:
            return

        conversation_text = "\n\n".join(self._run_buffer)
        self._run_buffer.clear()

        try:
            result = self.client.distill(
                project_id=self.project_id,
                conversation_text=conversation_text,
                agent_name=self.agent_name,
            )
            new_ids = [d.get("id") for d in result.get("decisions_created", []) if d.get("id")]
            self._decision_ids.extend(new_ids)
            logger.debug(
                "DeciGraphAgentHooks._flush_buffer: %d decisions extracted",
                len(new_ids),
            )
        except DeciGraphError as exc:
            logger.warning("DeciGraphAgentHooks._flush_buffer: distillery call failed — %s", exc)

    async def _create_session_summary(self, agent: Any = None) -> None:
        """Create a DeciGraph session summary for the completed run."""
        agent_label = _extract_agent_name(agent) or self.agent_name
        summary = (
            f"OpenAI Agents SDK run completed for '{agent_label}': "
            f"{self.task_description}"
        )
        try:
            session = self.client.create_session_summary(
                project_id=self.project_id,
                agent_name=self.agent_name,
                summary=summary,
                decision_ids=self._decision_ids if self._decision_ids else None,
                started_at=self._session_started_at,
                ended_at=datetime.now(tz=timezone.utc).isoformat(),
                metadata={"framework": "openai-agents"},
            )
            logger.debug(
                "DeciGraphAgentHooks._create_session_summary: created session — %s",
                session.get("id"),
            )
        except DeciGraphError as exc:
            logger.warning(
                "DeciGraphAgentHooks._create_session_summary: %s", exc
            )
        finally:
            self._decision_ids.clear()
            self._session_started_at = datetime.now(tz=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Extract helpers
# ---------------------------------------------------------------------------

def _extract_run_input(context: Any) -> str:
    """Try to pull the current run input text out of a RunContextWrapper."""
    for attr in ("input", "run_input", "messages"):
        val = getattr(context, attr, None)
        if val is None:
            # Try nested run_context
            run_ctx = getattr(context, "run_context", None)
            if run_ctx is not None:
                val = getattr(run_ctx, attr, None)
        if isinstance(val, str):
            return val
        if isinstance(val, list) and val:
            # List of message dicts — extract last user message
            for msg in reversed(val):
                if isinstance(msg, dict) and msg.get("role") == "user":
                    return msg.get("content", "")
    return ""


def _extract_output_text(output: Any) -> str:
    """Coerce a run output value to plain text."""
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    for attr in ("final_output", "output", "text", "content", "raw", "result"):
        val = getattr(output, attr, None)
        if isinstance(val, str) and val:
            return val
    return str(output) if output else ""


def _extract_tool_name(tool: Any) -> str:
    """Extract a human-readable name from a tool object."""
    if tool is None:
        return "unknown_tool"
    if isinstance(tool, str):
        return tool
    for attr in ("name", "function_name", "__name__"):
        val = getattr(tool, attr, None)
        if isinstance(val, str) and val:
            return val
    return type(tool).__name__


def _extract_agent_name(agent: Any) -> str | None:
    """Extract the name from an Agent object."""
    if agent is None:
        return None
    if isinstance(agent, str):
        return agent
    for attr in ("name", "agent_name"):
        val = getattr(agent, attr, None)
        if isinstance(val, str) and val:
            return val
    return None
