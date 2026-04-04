"""
decigraph-autogen — Memory
=======================
DeciGraph memory implementation for Microsoft AutoGen agents.

AutoGen agents (``ConversableAgent`` and its subclasses) support custom memory
backends via the ``transform_messages`` hook or by subclassing.  This module
provides a self-contained ``DeciGraphAutoGenMemory`` class that:

* Injects relevant DeciGraph context into the system message at conversation start.
* Buffers incoming messages and periodically extracts decisions via the
  DeciGraph distillery.
* Creates a ``SessionSummary`` when the session ends.

Usage with AutoGen v0.4+::

    from decigraph_sdk import DeciGraphClient
    from decigraph_autogen import DeciGraphAutoGenMemory
    import autogen

    client = DeciGraphClient()
    decigraph_mem = DeciGraphAutoGenMemory(
        client=client,
        project_id="proj-123",
        agent_name="assistant",
        task_description="Implement the payments module.",
    )

    # Get context to prepend to the system message
    system_ctx = decigraph_mem.get_context()

    assistant = autogen.AssistantAgent(
        name="assistant",
        system_message=f"{system_ctx}\n\nYou are a helpful assistant...",
        llm_config={...},
    )

    # After each message exchange, store it
    decigraph_mem.store_message(role="user", content="...")
    decigraph_mem.store_message(role="assistant", content="...")

    # When done
    decigraph_mem.on_session_end()
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Literal

from decigraph_sdk import DeciGraphClient
from decigraph_sdk.exceptions import DeciGraphError

logger = logging.getLogger(__name__)

MessageRole = Literal["user", "assistant", "system", "tool", "function"]

# Number of messages to accumulate before auto-distilling
_DEFAULT_DISTILL_EVERY = 10


class DeciGraphAutoGenMemory:
    """
    DeciGraph memory for AutoGen agents.

    Parameters
    ----------
    client:
        An initialised ``DeciGraphClient`` instance.
    project_id:
        The Nexus project to scope reads and writes to.
    agent_name:
        The AutoGen agent's name.
    task_description:
        Description of the current task, used for context compilation.
    max_tokens:
        Optional token budget for context compilation.
    distill_every:
        Auto-distil after this many stored messages (default 10).
        Set to ``0`` to disable automatic distillation (call
        ``flush_to_distillery()`` manually).
    create_session_on_end:
        When ``True`` (default), ``on_session_end()`` creates a Nexus
        ``SessionSummary``.
    """

    def __init__(
        self,
        client: DeciGraphClient,
        project_id: str,
        agent_name: str,
        task_description: str = "Perform the current task.",
        max_tokens: int | None = None,
        distill_every: int = _DEFAULT_DISTILL_EVERY,
        create_session_on_end: bool = True,
    ) -> None:
        self.client = client
        self.project_id = project_id
        self.agent_name = agent_name
        self.task_description = task_description
        self.max_tokens = max_tokens
        self.distill_every = distill_every
        self.create_session_on_end = create_session_on_end

        self._messages: list[dict[str, str]] = []
        self._decision_ids: list[str] = []
        self._session_started_at: str = datetime.now(tz=timezone.utc).isoformat()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def get_context(self, task_description: str | None = None) -> str:
        """
        Compile and return context from DeciGraph as a plain string.

        Typically called once at the start of a session to populate the
        agent's system message.

        Parameters
        ----------
        task_description:
            Override the instance-level task description for this call.

        Returns
        -------
        str
            Compiled context text, or an empty string if Nexus is unreachable.
        """
        task = task_description or self.task_description
        try:
            pkg = self.client.compile_context(
                project_id=self.project_id,
                agent_name=self.agent_name,
                task_description=task,
                max_tokens=self.max_tokens,
            )
            return pkg.get("compiled_text", "")
        except DeciGraphError as exc:
            logger.warning("DeciGraphAutoGenMemory.get_context: %s", exc)
            return ""

    def get_relevant_decisions(self, query: str | None = None) -> list[dict[str, Any]]:
        """
        Return a list of decisions relevant to *query* (or the task description).

        Parameters
        ----------
        query:
            Natural-language query to rank decisions against.

        Returns
        -------
        list[dict]
            Relevant decision dicts (may be empty on error).
        """
        task = query or self.task_description
        try:
            pkg = self.client.compile_context(
                project_id=self.project_id,
                agent_name=self.agent_name,
                task_description=task,
                max_tokens=self.max_tokens,
            )
            return pkg.get("relevant_decisions", [])
        except DeciGraphError as exc:
            logger.warning("DeciGraphAutoGenMemory.get_relevant_decisions: %s", exc)
            return []

    def store_message(
        self,
        role: MessageRole,
        content: str,
        name: str | None = None,
    ) -> None:
        """
        Buffer an AutoGen message for later distillation.

        Parameters
        ----------
        role:
            The message role (``"user"``, ``"assistant"``, ``"system"``, etc.).
        content:
            The message text.
        name:
            Optional sender name (used for tool / function messages).
        """
        entry: dict[str, str] = {"role": role, "content": content}
        if name:
            entry["name"] = name
        self._messages.append(entry)

        # Auto-distil when the buffer reaches the threshold
        if self.distill_every > 0 and len(self._messages) >= self.distill_every:
            self.flush_to_distillery()

    def store_messages_batch(self, messages: list[dict[str, Any]]) -> None:
        """
        Store a batch of AutoGen message dicts at once.

        Each dict must contain at least ``"role"`` and ``"content"`` keys.

        Parameters
        ----------
        messages:
            List of message dicts in AutoGen's native format.
        """
        for msg in messages:
            self.store_message(
                role=msg.get("role", "user"),  # type: ignore[arg-type]
                content=msg.get("content", ""),
                name=msg.get("name"),
            )

    def flush_to_distillery(self) -> None:
        """
        Send all buffered messages to the DeciGraph distillery and clear the buffer.

        Decision IDs extracted during this flush are accumulated for the
        final session summary.
        """
        if not self._messages:
            return

        conversation_text = _format_messages(self._messages)
        self._messages.clear()

        try:
            result = self.client.distill(
                project_id=self.project_id,
                conversation_text=conversation_text,
                agent_name=self.agent_name,
            )
            new_ids = [d.get("id") for d in result.get("decisions_created", []) if d.get("id")]
            self._decision_ids.extend(new_ids)
            logger.debug(
                "DeciGraphAutoGenMemory.flush_to_distillery: %d decisions extracted",
                len(new_ids),
            )
        except DeciGraphError as exc:
            logger.warning("DeciGraphAutoGenMemory.flush_to_distillery: %s", exc)

    def on_session_end(
        self,
        summary: str | None = None,
        additional_decision_ids: list[str] | None = None,
    ) -> dict[str, Any] | None:
        """
        Finalise the session: flush remaining messages and create a summary.

        Parameters
        ----------
        summary:
            Optional human-readable session summary.  If omitted, a default
            summary is generated from the task description and message count.
        additional_decision_ids:
            Extra decision IDs to link to the session.

        Returns
        -------
        dict | None
            The created ``SessionSummary`` dict, or ``None`` on error.
        """
        # Flush any remaining buffered messages
        self.flush_to_distillery()

        if not self.create_session_on_end:
            return None

        all_decision_ids = self._decision_ids.copy()
        if additional_decision_ids:
            all_decision_ids.extend(additional_decision_ids)

        session_summary = summary or (
            f"AutoGen session for agent '{self.agent_name}': {self.task_description}"
        )

        try:
            session = self.client.create_session_summary(
                project_id=self.project_id,
                agent_name=self.agent_name,
                summary=session_summary,
                decision_ids=all_decision_ids if all_decision_ids else None,
                started_at=self._session_started_at,
                ended_at=datetime.now(tz=timezone.utc).isoformat(),
                metadata={"framework": "autogen"},
            )
            logger.debug(
                "DeciGraphAutoGenMemory.on_session_end: session summary created — %s",
                session.get("id"),
            )
            # Reset for next session
            self._decision_ids.clear()
            self._session_started_at = datetime.now(tz=timezone.utc).isoformat()
            return session
        except DeciGraphError as exc:
            logger.warning("DeciGraphAutoGenMemory.on_session_end: %s", exc)
            return None

    # ------------------------------------------------------------------
    # Transform-messages hook (AutoGen v0.4 style)
    # ------------------------------------------------------------------

    def transform_messages_hook(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        AutoGen ``TransformMessages`` compatible hook.

        Pass this method (or an instance bound to it) to
        ``TransformMessages(transforms=[self.transform_messages_hook])`` to
        automatically inject DeciGraph context into each LLM call.

        The hook prepends a system message containing compiled DeciGraph context
        if one is not already present at position 0.

        Parameters
        ----------
        messages:
            The message list AutoGen is about to send to the LLM.

        Returns
        -------
        list[dict]
            The (potentially augmented) message list.
        """
        context_text = self.get_context()
        if not context_text:
            return messages

        # Don't duplicate the context if it's already injected
        if messages and messages[0].get("role") == "system":
            existing = messages[0].get("content", "")
            if context_text[:50] in existing:
                return messages

        context_message: dict[str, Any] = {
            "role": "system",
            "content": f"[Nexus Context]\n{context_text}",
        }
        return [context_message] + list(messages)

    # ------------------------------------------------------------------
    # Dunder helpers
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        return (
            f"DeciGraphAutoGenMemory("
            f"project_id={self.project_id!r}, "
            f"agent_name={self.agent_name!r}, "
            f"buffered={len(self._messages)})"
        )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _format_messages(messages: list[dict[str, str]]) -> str:
    """Format a list of message dicts into a plain-text conversation transcript."""
    lines: list[str] = []
    for msg in messages:
        role = msg.get("role", "unknown").capitalize()
        name = msg.get("name")
        content = msg.get("content", "")
        prefix = f"{role} ({name})" if name else role
        lines.append(f"{prefix}: {content}")
    return "\n".join(lines)
