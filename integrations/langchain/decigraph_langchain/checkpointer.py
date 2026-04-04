"""
nexus-langchain — LangGraph Checkpointer
=========================================
A LangGraph ``BaseCheckpointSaver`` implementation that stores checkpoints as
DeciGraph session summaries and rehydrates state by compiling context from DeciGraph.

This lets LangGraph persist agent state across runs without any external
key-value store — DeciGraph itself acts as the durable state layer.

Usage::

    from decigraph_sdk import DeciGraphClient
    from decigraph_langchain import DeciGraphCheckpointer
    from langgraph.graph import StateGraph

    client = DeciGraphClient()
    checkpointer = DeciGraphCheckpointer(
        client=client,
        project_id="proj-123",
        agent_name="orchestrator",
    )

    graph = StateGraph(MyState)
    # ... add nodes / edges ...
    app = graph.compile(checkpointer=checkpointer)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Iterator, Sequence

from decigraph_sdk import DeciGraphClient
from decigraph_sdk.exceptions import DeciGraphError

try:
    from langchain_core.runnables import RunnableConfig
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "langchain-core is required for nexus-langchain. "
        "Install it with: pip install langchain-core>=0.3.0"
    ) from exc

try:
    from langgraph.checkpoint.base import (
        BaseCheckpointSaver,
        Checkpoint,
        CheckpointMetadata,
        CheckpointTuple,
        SerializerProtocol,
        get_checkpoint_id,
    )
except ImportError:
    # Graceful degradation: define minimal stubs so the module can be imported
    # even without langgraph installed.  Actual use will raise at runtime.
    class BaseCheckpointSaver:  # type: ignore[no-redef]
        pass

    Checkpoint = dict  # type: ignore[misc, assignment]
    CheckpointMetadata = dict  # type: ignore[misc, assignment]
    CheckpointTuple = tuple  # type: ignore[misc, assignment]
    SerializerProtocol = object  # type: ignore[misc, assignment]

    def get_checkpoint_id(*_: Any) -> str | None:  # type: ignore[misc]
        return None


logger = logging.getLogger(__name__)

_DECIGRAPH_CHECKPOINT_TAG = "langgraph-checkpoint"


class DeciGraphCheckpointer(BaseCheckpointSaver):
    """
    LangGraph checkpoint saver backed by DeciGraph session summaries.

    Each ``put`` operation serialises the full LangGraph checkpoint to JSON
    and saves it as a DeciGraph ``SessionSummary``.  Each ``get`` operation
    queries the most recent session summary for the thread and deserialises it.

    The ``compile_context`` endpoint is also called during ``get`` so that
    the agent's context window is pre-populated with relevant decisions.

    Parameters
    ----------
    client:
        An initialised ``DeciGraphClient`` instance.
    project_id:
        The DeciGraph project to store checkpoints under.
    agent_name:
        Agent name used for context compilation.
    task_description:
        Default task description for context compilation.
    max_tokens:
        Optional token budget for context compilation.
    """

    def __init__(
        self,
        client: DeciGraphClient,
        project_id: str,
        agent_name: str,
        task_description: str = "Continue the current task.",
        max_tokens: int | None = None,
    ) -> None:
        super().__init__()
        self.client = client
        self.project_id = project_id
        self.agent_name = agent_name
        self.task_description = task_description
        self.max_tokens = max_tokens

    # ------------------------------------------------------------------
    # BaseCheckpointSaver interface
    # ------------------------------------------------------------------

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        """
        Retrieve the most recent checkpoint for the given thread config.

        DeciGraph session summaries are queried by agent name; the latest one
        whose metadata contains a ``checkpoint_id`` matching the config is
        returned.

        Returns ``None`` if no checkpoint is found.
        """
        thread_id: str | None = (config.get("configurable") or {}).get("thread_id")
        checkpoint_id: str | None = get_checkpoint_id(config)

        try:
            sessions = self.client.list_session_summaries(
                project_id=self.project_id,
                agent_name=self.agent_name,
                limit=50,
            )
        except DeciGraphError as exc:
            logger.warning("DeciGraphCheckpointer.get_tuple: %s", exc)
            return None

        # Filter to sessions that look like checkpoints for this thread
        candidates = [
            s for s in sessions
            if s.get("metadata", {}).get("thread_id") == thread_id
            and _DECIGRAPH_CHECKPOINT_TAG in s.get("metadata", {}).get("tags", [])
        ]
        if not candidates:
            return None

        # If a specific checkpoint_id was requested, filter further
        if checkpoint_id:
            candidates = [
                c for c in candidates
                if c.get("metadata", {}).get("checkpoint_id") == checkpoint_id
            ]
            if not candidates:
                return None

        # Take the most recent
        latest = candidates[-1]
        return self._session_to_tuple(latest, config)

    def list(
        self,
        config: RunnableConfig,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        """Yield all checkpoints for the given thread, newest first."""
        thread_id: str | None = (config.get("configurable") or {}).get("thread_id")
        try:
            sessions = self.client.list_session_summaries(
                project_id=self.project_id,
                agent_name=self.agent_name,
                limit=limit or 100,
            )
        except DeciGraphError as exc:
            logger.warning("DeciGraphCheckpointer.list: %s", exc)
            return

        for session in reversed(sessions):
            meta = session.get("metadata", {})
            if meta.get("thread_id") != thread_id:
                continue
            if _DECIGRAPH_CHECKPOINT_TAG not in meta.get("tags", []):
                continue
            tup = self._session_to_tuple(session, config)
            if tup is not None:
                yield tup

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: dict[str, Any],
    ) -> RunnableConfig:
        """
        Persist a LangGraph checkpoint as a DeciGraph session summary.

        The checkpoint payload is JSON-serialised and stored in the session
        summary's ``metadata`` field.  Decision IDs referenced in
        ``checkpoint.get("channel_values", {}).get("decisions", [])`` are
        linked to the session.

        Returns
        -------
        RunnableConfig
            Updated config with the new ``checkpoint_id``.
        """
        thread_id: str | None = (config.get("configurable") or {}).get("thread_id")
        checkpoint_id: str | None = checkpoint.get("id")

        # Harvest decision IDs that LangGraph state might carry
        channel_values: dict[str, Any] = checkpoint.get("channel_values", {})
        decision_ids: list[str] = channel_values.get("decisions", [])
        if isinstance(decision_ids, str):
            decision_ids = [decision_ids]

        # Build human-readable summary
        summary_lines = [
            f"LangGraph checkpoint for thread '{thread_id}'",
            f"Checkpoint ID: {checkpoint_id}",
            f"Step: {metadata.get('step', '?')}",
        ]
        if source := metadata.get("source"):
            summary_lines.append(f"Source: {source}")
        summary = " | ".join(summary_lines)

        session_metadata = {
            "thread_id": thread_id,
            "checkpoint_id": checkpoint_id,
            "tags": [_DECIGRAPH_CHECKPOINT_TAG],
            "checkpoint_payload": json.dumps(checkpoint, default=str),
            "langgraph_metadata": metadata,
        }

        try:
            session = self.client.create_session_summary(
                project_id=self.project_id,
                agent_name=self.agent_name,
                summary=summary,
                decision_ids=decision_ids if decision_ids else None,
                ended_at=datetime.now(tz=timezone.utc).isoformat(),
                metadata=session_metadata,
            )
            logger.debug(
                "DeciGraphCheckpointer.put: saved checkpoint %s as session %s",
                checkpoint_id,
                session.get("id"),
            )
        except DeciGraphError as exc:
            logger.warning("DeciGraphCheckpointer.put: %s", exc)

        return {
            **config,
            "configurable": {
                **(config.get("configurable") or {}),
                "checkpoint_id": checkpoint_id,
                "thread_id": thread_id,
            },
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _session_to_tuple(
        self,
        session: dict[str, Any],
        config: RunnableConfig,
    ) -> CheckpointTuple | None:
        """Deserialise a DeciGraph session summary back into a CheckpointTuple."""
        meta = session.get("metadata", {})
        payload_json: str = meta.get("checkpoint_payload", "")
        if not payload_json:
            return None

        try:
            checkpoint: Checkpoint = json.loads(payload_json)
        except json.JSONDecodeError as exc:
            logger.warning("DeciGraphCheckpointer: failed to parse checkpoint payload — %s", exc)
            return None

        checkpoint_meta: CheckpointMetadata = meta.get("langgraph_metadata", {})
        checkpoint_id: str = meta.get("checkpoint_id", "")
        thread_id: str = meta.get("thread_id", "")

        child_config: RunnableConfig = {
            **config,
            "configurable": {
                **(config.get("configurable") or {}),
                "thread_id": thread_id,
                "checkpoint_id": checkpoint_id,
            },
        }
        return CheckpointTuple(
            config=child_config,
            checkpoint=checkpoint,
            metadata=checkpoint_meta,
            parent_config=None,
        )
