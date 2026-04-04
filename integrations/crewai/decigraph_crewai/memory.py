"""
decigraph-crewai — Memory Backend
==============================
A CrewAI memory backend that delegates storage and retrieval to DeciGraph.

CrewAI calls ``save()`` after each task completes and ``search()`` whenever
an agent needs to recall information.  This implementation maps those
operations onto the DeciGraph distillery and context compiler respectively.

Usage::

    from decigraph_sdk import DeciGraphClient
    from decigraph_crewai import DeciGraphCrewMemory

    client = DeciGraphClient()
    memory = DeciGraphCrewMemory(
        client=client,
        project_id="proj-123",
        agent_name="researcher",
    )

    # Inject into a CrewAI Agent
    from crewai import Agent
    agent = Agent(
        role="Research Analyst",
        memory=True,
        ...
    )
    # Attach memory backend
    agent._memory_handler = memory   # or via CrewAI's custom memory API
"""

from __future__ import annotations

import logging
from typing import Any

from decigraph_sdk import DeciGraphClient
from decigraph_sdk.exceptions import DeciGraphError

logger = logging.getLogger(__name__)


class DeciGraphCrewMemory:
    """
    CrewAI memory backend backed by DeciGraph.

    Parameters
    ----------
    client:
        An initialised ``DeciGraphClient`` instance.
    project_id:
        The DeciGraph project that owns this agent's memory.
    agent_name:
        The CrewAI agent's name, used for attribution and context filtering.
    default_task_description:
        Fallback task description used when ``search()`` is called without
        an explicit task context.
    max_tokens:
        Optional token budget for context compilation.
    distill_on_save:
        When ``True`` (default), every ``save()`` call immediately sends
        content to the DeciGraph distillery.  Set to ``False`` to batch manually.
    """

    def __init__(
        self,
        client: DeciGraphClient,
        project_id: str,
        agent_name: str,
        default_task_description: str = "Perform the current crew task.",
        max_tokens: int | None = None,
        distill_on_save: bool = True,
    ) -> None:
        self.client = client
        self.project_id = project_id
        self.agent_name = agent_name
        self.default_task_description = default_task_description
        self.max_tokens = max_tokens
        self.distill_on_save = distill_on_save

        # Internal cache: stores (text, metadata) tuples pending distillation
        self._pending: list[tuple[str, dict[str, Any]]] = []

    # ------------------------------------------------------------------
    # CrewAI memory interface
    # ------------------------------------------------------------------

    def save(
        self,
        value: str,
        metadata: dict[str, Any] | None = None,
        agent: str | None = None,
    ) -> None:
        """
        Persist a piece of information from a completed task.

        When ``distill_on_save`` is ``True``, the text is immediately shipped
        to the DeciGraph distillery.  Otherwise it is buffered and can be flushed
        with ``flush()``.

        Parameters
        ----------
        value:
            The text content to persist (task output, observation, etc.).
        metadata:
            Optional key-value metadata to attach (e.g. task ID, tool name).
        agent:
            Optional agent name override (falls back to ``self.agent_name``).
        """
        agent_name = agent or self.agent_name
        meta = metadata or {}

        if self.distill_on_save:
            self._distill_text(value, agent_name=agent_name, extra_meta=meta)
        else:
            self._pending.append((value, {"agent_name": agent_name, **meta}))

    def search(
        self,
        query: str,
        task_description: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Retrieve information relevant to *query* from DeciGraph.

        Calls ``compile_context`` and returns the list of relevant decisions
        together with the compiled text as the first element.

        Parameters
        ----------
        query:
            The search query or current task context.
        task_description:
            Optional override for the task description passed to DeciGraph.
        limit:
            Not used directly (DeciGraph controls result count via token budget),
            but stored in the metadata for future API extensions.

        Returns
        -------
        list[dict]
            A list of result dicts, each with ``type``, ``text``, and
            optional ``score`` / ``decision_id`` fields.  The first element
            is always the compiled context blob.
        """
        task = task_description or query or self.default_task_description

        try:
            pkg = self.client.compile_context(
                project_id=self.project_id,
                agent_name=self.agent_name,
                task_description=task,
                max_tokens=self.max_tokens,
            )
        except DeciGraphError as exc:
            logger.warning("DeciGraphCrewMemory.search: context compilation failed — %s", exc)
            return []

        results: list[dict[str, Any]] = []

        # Include the compiled text blob as the first result
        compiled_text: str = pkg.get("compiled_text", "")
        if compiled_text:
            results.append({"type": "context", "text": compiled_text, "score": 1.0})

        # Include individual decisions as discrete results
        for decision in pkg.get("relevant_decisions", []):
            results.append(
                {
                    "type": "decision",
                    "decision_id": decision.get("id"),
                    "text": f"{decision.get('title', '')}: {decision.get('description', '')}",
                    "score": decision.get("confidence", 1.0),
                }
            )

        return results

    def reset(self) -> None:
        """
        Clear the in-process pending buffer.

        Note: this does *not* delete persisted data from DeciGraph.  It only
        discards buffered items that have not yet been distilled.
        """
        self._pending.clear()
        logger.debug("DeciGraphCrewMemory.reset: pending buffer cleared for agent '%s'", self.agent_name)

    def flush(self) -> None:
        """
        Flush all buffered items to the DeciGraph distillery.

        Call this when ``distill_on_save=False`` and you want to batch-submit
        accumulated task outputs.
        """
        if not self._pending:
            return
        combined = "\n\n".join(text for text, _ in self._pending)
        agent_name = self.agent_name
        self._pending.clear()
        self._distill_text(combined, agent_name=agent_name)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _distill_text(
        self,
        text: str,
        agent_name: str | None = None,
        extra_meta: dict[str, Any] | None = None,
    ) -> None:
        """Send *text* to the DeciGraph distillery."""
        if not text.strip():
            return
        try:
            result = self.client.distill(
                project_id=self.project_id,
                conversation_text=text,
                agent_name=agent_name or self.agent_name,
            )
            n = len(result.get("decisions_created", []))
            logger.debug("DeciGraphCrewMemory: distilled → %d decisions extracted", n)
        except DeciGraphError as exc:
            logger.warning("DeciGraphCrewMemory._distill_text: %s", exc)
