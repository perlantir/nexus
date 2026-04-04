"""
nexus-crewai — Task & Crew Callbacks
======================================
CrewAI callback objects that automatically capture task and crew outputs and
forward them to the DeciGraph distillery / session summary API.

CrewAI's callback interface accepts plain callables or objects with
``on_task_complete`` / ``on_crew_complete`` methods.  Both styles are
supported here.

Usage::

    from decigraph_sdk import DeciGraphClient
    from decigraph_crewai import DeciGraphCrewCallback

    client = DeciGraphClient()
    cb = DeciGraphCrewCallback(client=client, project_id="proj-123")

    from crewai import Crew, Task, Agent
    crew = Crew(
        agents=[...],
        tasks=[...],
        task_callback=cb.on_task_complete,
        step_callback=cb.on_step,
    )
    crew.kickoff()
    cb.on_crew_complete(crew_output="...full crew output...")
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from decigraph_sdk import DeciGraphClient
from decigraph_sdk.exceptions import DeciGraphError

logger = logging.getLogger(__name__)


class DeciGraphCrewCallback:
    """
    Callback object for CrewAI that ships task and crew outputs to DeciGraph.

    Parameters
    ----------
    client:
        An initialised ``DeciGraphClient`` instance.
    project_id:
        The DeciGraph project to associate all captured data with.
    agent_name:
        Default agent name for attribution when the task does not specify one.
    create_session_on_crew_end:
        When ``True`` (default) a DeciGraph ``SessionSummary`` is created when
        ``on_crew_complete()`` is called.
    """

    def __init__(
        self,
        client: DeciGraphClient,
        project_id: str,
        agent_name: str = "crew",
        create_session_on_crew_end: bool = True,
    ) -> None:
        self.client = client
        self.project_id = project_id
        self.agent_name = agent_name
        self.create_session_on_crew_end = create_session_on_crew_end

        self._task_outputs: list[dict[str, Any]] = []
        self._session_started_at: str = datetime.now(tz=timezone.utc).isoformat()
        self._decision_ids: list[str] = []

    # ------------------------------------------------------------------
    # Task lifecycle
    # ------------------------------------------------------------------

    def on_task_complete(self, task: Any, output: Any = None) -> None:
        """
        Called by CrewAI when a single task finishes.

        The task output is sent to the DeciGraph distillery.  Any decisions
        extracted are collected for the final crew session summary.

        Parameters
        ----------
        task:
            The CrewAI ``Task`` object (or any object with a ``description``
            attribute and optional ``agent`` attribute).
        output:
            The task output string or ``TaskOutput`` object.
        """
        # Extract string output robustly
        output_text: str = _extract_text(output)
        task_desc: str = _extract_task_description(task)
        agent_name: str = _extract_agent_name(task) or self.agent_name

        if not output_text:
            logger.debug("DeciGraphCrewCallback.on_task_complete: empty output, skipping distillery")
            return

        conversation = f"Task: {task_desc}\n\nOutput:\n{output_text}"

        self._task_outputs.append(
            {"task_description": task_desc, "agent_name": agent_name, "output": output_text}
        )

        try:
            result = self.client.distill(
                project_id=self.project_id,
                conversation_text=conversation,
                agent_name=agent_name,
            )
            new_ids = [d.get("id") for d in result.get("decisions_created", []) if d.get("id")]
            self._decision_ids.extend(new_ids)
            logger.debug(
                "DeciGraphCrewCallback.on_task_complete: %d decisions extracted for task '%s'",
                len(new_ids),
                task_desc[:60],
            )
        except DeciGraphError as exc:
            logger.warning("DeciGraphCrewCallback.on_task_complete: distillery call failed — %s", exc)

    def on_step(self, step: Any) -> None:
        """
        Called by CrewAI on each agent step (tool use, intermediate thought).

        By default this is a no-op.  Override or monkey-patch to capture
        intermediate reasoning.
        """
        pass

    # ------------------------------------------------------------------
    # Crew lifecycle
    # ------------------------------------------------------------------

    def on_crew_complete(
        self,
        crew_output: Any = None,
        crew: Any = None,
    ) -> None:
        """
        Called when the entire crew finishes all tasks.

        Creates a DeciGraph ``SessionSummary`` that links all decisions extracted
        during the run.

        Parameters
        ----------
        crew_output:
            The crew's final output (string or ``CrewOutput`` object).
        crew:
            The CrewAI ``Crew`` object (optional, used to extract metadata).
        """
        if not self.create_session_on_crew_end:
            return

        output_text = _extract_text(crew_output)
        task_count = len(self._task_outputs)

        summary_lines = [f"CrewAI run completed: {task_count} task(s) executed."]
        if output_text:
            # Truncate very long outputs in the summary
            preview = output_text[:500] + ("..." if len(output_text) > 500 else "")
            summary_lines.append(f"Final output: {preview}")

        summary = "\n".join(summary_lines)

        try:
            session = self.client.create_session_summary(
                project_id=self.project_id,
                agent_name=self.agent_name,
                summary=summary,
                decision_ids=self._decision_ids if self._decision_ids else None,
                started_at=self._session_started_at,
                ended_at=datetime.now(tz=timezone.utc).isoformat(),
                metadata={
                    "framework": "crewai",
                    "task_count": task_count,
                },
            )
            logger.debug(
                "DeciGraphCrewCallback.on_crew_complete: session summary created — %s",
                session.get("id"),
            )
        except DeciGraphError as exc:
            logger.warning(
                "DeciGraphCrewCallback.on_crew_complete: session summary failed — %s", exc
            )
        finally:
            # Reset for potential re-use
            self._task_outputs.clear()
            self._decision_ids.clear()
            self._session_started_at = datetime.now(tz=timezone.utc).isoformat()

    # ------------------------------------------------------------------
    # Convenience: make the instance directly callable as a task callback
    # ------------------------------------------------------------------

    def __call__(self, task: Any = None, output: Any = None) -> None:
        """Allow the instance to be passed directly as a CrewAI task callback."""
        self.on_task_complete(task=task, output=output)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_text(obj: Any) -> str:
    """Return a string from a CrewAI output object or plain string."""
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj
    # CrewOutput / TaskOutput have a .raw or .result attribute
    for attr in ("raw", "result", "output", "text", "content"):
        value = getattr(obj, attr, None)
        if isinstance(value, str) and value:
            return value
    return str(obj)


def _extract_task_description(task: Any) -> str:
    """Extract a human-readable description from a CrewAI Task object."""
    if task is None:
        return "Unknown task"
    if isinstance(task, str):
        return task
    for attr in ("description", "name", "title"):
        value = getattr(task, attr, None)
        if isinstance(value, str) and value:
            return value
    return str(task)


def _extract_agent_name(task: Any) -> str | None:
    """Try to determine which agent ran this task."""
    if task is None:
        return None
    # CrewAI Task.agent is an Agent object with .role / .name
    agent = getattr(task, "agent", None)
    if agent is None:
        return None
    for attr in ("name", "role"):
        value = getattr(agent, attr, None)
        if isinstance(value, str) and value:
            return value
    return None
