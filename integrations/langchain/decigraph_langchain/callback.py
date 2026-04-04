"""
nexus-langchain — Callback Handler
===================================
LangChain ``BaseCallbackHandler`` that automatically captures LLM and chain
outputs and forwards them to the DeciGraph distillery for decision extraction.

Usage::

    from decigraph_sdk import DeciGraphClient
    from decigraph_langchain import DeciGraphCallbackHandler

    client = DeciGraphClient()
    handler = DeciGraphCallbackHandler(
        client=client,
        project_id="proj-123",
        agent_name="coder-agent",
    )

    chain.invoke({"input": "..."}, config={"callbacks": [handler]})
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from decigraph_sdk import DeciGraphClient

try:
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.outputs import LLMResult
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "langchain-core is required for nexus-langchain. "
        "Install it with: pip install langchain-core>=0.3.0"
    ) from exc

logger = logging.getLogger(__name__)


class DeciGraphCallbackHandler(BaseCallbackHandler):
    """
    Callback handler that ships conversation data to the DeciGraph distillery.

    The handler buffers LLM outputs across the run.  When the top-level chain
    ends (``on_chain_end``), the accumulated text is flushed to the distillery
    in a single API call.

    Parameters
    ----------
    client:
        An initialised ``DeciGraphClient`` instance.
    project_id:
        The DeciGraph project to associate all captured data with.
    agent_name:
        Agent name used to attribute extracted decisions.
    capture_tool_outputs:
        When ``True`` (default), tool call results are appended to the buffer
        as potential decision signals.
    capture_llm_outputs:
        When ``True`` (default), LLM generation text is appended to the buffer.
    distill_on_chain_end:
        When ``True`` (default), flush to the distillery when the *outermost*
        chain ends.  Set to ``False`` if you want to flush manually via
        ``flush()``.
    """

    def __init__(
        self,
        client: DeciGraphClient,
        project_id: str,
        agent_name: str,
        capture_tool_outputs: bool = True,
        capture_llm_outputs: bool = True,
        distill_on_chain_end: bool = True,
    ) -> None:
        super().__init__()
        self.client = client
        self.project_id = project_id
        self.agent_name = agent_name
        self.capture_tool_outputs = capture_tool_outputs
        self.capture_llm_outputs = capture_llm_outputs
        self.distill_on_chain_end = distill_on_chain_end

        self._buffer: list[str] = []
        self._chain_depth: int = 0  # track nested chain calls

    # ------------------------------------------------------------------
    # LLM callbacks
    # ------------------------------------------------------------------

    def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        """Buffer LLM generation text when ``capture_llm_outputs`` is True."""
        if not self.capture_llm_outputs:
            return
        for gen_list in response.generations:
            for gen in gen_list:
                text = getattr(gen, "text", None) or ""
                if text:
                    self._buffer.append(f"[LLM Output]\n{text.strip()}")

    # ------------------------------------------------------------------
    # Tool callbacks
    # ------------------------------------------------------------------

    def on_tool_end(
        self,
        output: str,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        """Buffer tool output text when ``capture_tool_outputs`` is True."""
        if not self.capture_tool_outputs:
            return
        tool_name: str = kwargs.get("name") or "unknown_tool"
        if output:
            self._buffer.append(f"[Tool: {tool_name}]\n{output.strip()}")

    # ------------------------------------------------------------------
    # Chain callbacks
    # ------------------------------------------------------------------

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        """Track nesting depth so we only flush on the outermost chain end."""
        self._chain_depth += 1
        # Capture the human input as context for the distillery
        for key in ("input", "question", "query", "human_input"):
            if key in inputs:
                self._buffer.append(f"[Human Input]\n{inputs[key]}")
                break

    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        """Capture chain output and flush to distillery at the top level."""
        self._chain_depth -= 1

        # Capture the AI output
        for key in ("output", "answer", "result", "text"):
            if key in outputs:
                self._buffer.append(f"[AI Output]\n{outputs[key]}")
                break

        if self.distill_on_chain_end and self._chain_depth == 0:
            self.flush()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def flush(self) -> None:
        """
        Send the accumulated buffer to the DeciGraph distillery and clear it.
        Call this manually if ``distill_on_chain_end=False``.
        """
        if not self._buffer:
            return
        conversation_text = "\n\n".join(self._buffer)
        self._buffer.clear()
        try:
            result = self.client.distill(
                project_id=self.project_id,
                conversation_text=conversation_text,
                agent_name=self.agent_name,
            )
            n = len(result.get("decisions_created", []))
            logger.debug("DeciGraphCallbackHandler: distilled → %d decisions extracted", n)
        except Exception as exc:
            logger.warning("DeciGraphCallbackHandler: distillery flush failed — %s", exc)

    def clear(self) -> None:
        """Discard the in-process buffer without sending to the distillery."""
        self._buffer.clear()
