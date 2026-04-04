"""
DeciGraph SDK — Client
==================
Synchronous HTTP client wrapping every DeciGraph REST endpoint.

Usage::

    from nexus_sdk import DeciGraphClient

    client = DeciGraphClient(base_url="http://localhost:3100", api_key="my-key")
    project = client.create_project("My Project", "A test project")
    decision = client.create_decision(
        project_id=project["id"],
        title="Use PostgreSQL",
        description="We will use PostgreSQL as our primary database.",
        reasoning="Team familiarity and strong JSON support.",
        made_by="architect-agent",
    )
"""

from __future__ import annotations

import logging
from typing import Any

import requests
from requests import Response, Session

from .exceptions import (
    DeciGraphApiError,
    DeciGraphAuthError,
    DeciGraphConnectionError,
    DeciGraphNotFoundError,
    DeciGraphValidationError,
)

logger = logging.getLogger(__name__)


class DeciGraphClient:
    """
    Synchronous client for the DeciGraph REST API.

    Parameters
    ----------
    base_url:
        Base URL of the running DeciGraph server (default ``http://localhost:3100``).
    api_key:
        Optional bearer token.  When provided it is sent as
        ``Authorization: Bearer <api_key>`` on every request.
    timeout:
        Default request timeout in seconds (default 30).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:3100",
        api_key: str | None = None,
        timeout: int = 30,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._session: Session = requests.Session()
        self._session.headers.update({"Content-Type": "application/json", "Accept": "application/json"})
        if api_key:
            self._session.headers["Authorization"] = f"Bearer {api_key}"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _handle_response(self, resp: Response) -> dict[str, Any] | list[Any] | None:
        """Raise a typed exception for non-2xx responses; otherwise return parsed JSON."""
        if resp.ok:
            if resp.status_code == 204 or not resp.content:
                return None
            return resp.json()

        # Attempt to parse error body
        try:
            body = resp.json()
        except Exception:
            body = {}

        message = body.get("message") or body.get("error") or resp.reason or "Unknown error"

        if resp.status_code == 401 or resp.status_code == 403:
            raise DeciGraphAuthError(resp.status_code, message, body)
        if resp.status_code == 404:
            raise DeciGraphNotFoundError(resp.status_code, message, body)
        if resp.status_code == 422:
            raise DeciGraphValidationError(resp.status_code, message, body)
        raise DeciGraphApiError(resp.status_code, message, body)

    def _get(self, path: str, params: dict | None = None) -> Any:
        try:
            resp = self._session.get(self._url(path), params=params, timeout=self.timeout)
        except requests.ConnectionError as exc:
            raise DeciGraphConnectionError(f"Cannot connect to DeciGraph at {self.base_url}") from exc
        return self._handle_response(resp)

    def _post(self, path: str, json: dict | None = None) -> Any:
        try:
            resp = self._session.post(self._url(path), json=json, timeout=self.timeout)
        except requests.ConnectionError as exc:
            raise DeciGraphConnectionError(f"Cannot connect to DeciGraph at {self.base_url}") from exc
        return self._handle_response(resp)

    def _patch(self, path: str, json: dict | None = None) -> Any:
        try:
            resp = self._session.patch(self._url(path), json=json, timeout=self.timeout)
        except requests.ConnectionError as exc:
            raise DeciGraphConnectionError(f"Cannot connect to DeciGraph at {self.base_url}") from exc
        return self._handle_response(resp)

    def _delete(self, path: str) -> None:
        try:
            resp = self._session.delete(self._url(path), timeout=self.timeout)
        except requests.ConnectionError as exc:
            raise DeciGraphConnectionError(f"Cannot connect to DeciGraph at {self.base_url}") from exc
        self._handle_response(resp)

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------

    def create_project(self, name: str, description: str | None = None) -> dict[str, Any]:
        """
        Create a new DeciGraph project.

        Parameters
        ----------
        name:
            Human-readable project name.
        description:
            Optional free-text description.

        Returns
        -------
        dict
            The created project object.
        """
        payload: dict[str, Any] = {"name": name}
        if description is not None:
            payload["description"] = description
        return self._post("/api/projects", payload)  # type: ignore[return-value]

    def get_project(self, project_id: str) -> dict[str, Any]:
        """
        Fetch a project by its ID.

        Parameters
        ----------
        project_id:
            The project UUID.

        Returns
        -------
        dict
            The project object.
        """
        return self._get(f"/api/projects/{project_id}")  # type: ignore[return-value]

    def list_projects(self) -> list[dict[str, Any]]:
        """Return all projects visible to this API key."""
        return self._get("/api/projects")  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Agents
    # ------------------------------------------------------------------

    def create_agent(
        self,
        project_id: str,
        name: str,
        role: str,
        description: str | None = None,
        capabilities: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Register a new agent within a project.

        Parameters
        ----------
        project_id:
            Owning project UUID.
        name:
            Unique agent name within the project.
        role:
            Short label describing the agent's function (e.g. ``"architect"``).
        description:
            Free-text description.
        capabilities:
            List of capability strings the agent supports.
        metadata:
            Arbitrary JSON metadata.

        Returns
        -------
        dict
            The created agent object.
        """
        payload: dict[str, Any] = {"name": name, "role": role}
        if description is not None:
            payload["description"] = description
        if capabilities is not None:
            payload["capabilities"] = capabilities
        if metadata is not None:
            payload["metadata"] = metadata
        return self._post(f"/api/projects/{project_id}/agents", payload)  # type: ignore[return-value]

    def get_agent(self, agent_id: str) -> dict[str, Any]:
        """Fetch an agent by its ID."""
        return self._get(f"/api/agents/{agent_id}")  # type: ignore[return-value]

    def list_agents(self, project_id: str) -> list[dict[str, Any]]:
        """List all agents belonging to *project_id*."""
        return self._get(f"/api/projects/{project_id}/agents")  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Decisions
    # ------------------------------------------------------------------

    def create_decision(
        self,
        project_id: str,
        title: str,
        description: str,
        reasoning: str,
        made_by: str,
        status: str = "active",
        confidence: float = 1.0,
        tags: list[str] | None = None,
        supersedes: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Record a new decision in a project.

        Parameters
        ----------
        project_id:
            Owning project UUID.
        title:
            Short, unique title.
        description:
            What was decided.
        reasoning:
            Why this decision was made.
        made_by:
            Name (or ID) of the agent or human that made the decision.
        status:
            ``"active"`` (default), ``"superseded"``, or ``"deprecated"``.
        confidence:
            Float 0–1 indicating certainty level.
        tags:
            Taxonomy labels.
        supersedes:
            List of decision IDs this decision replaces.
        metadata:
            Arbitrary JSON metadata.

        Returns
        -------
        dict
            The created decision object.
        """
        payload: dict[str, Any] = {
            "title": title,
            "description": description,
            "reasoning": reasoning,
            "made_by": made_by,
            "status": status,
            "confidence": confidence,
        }
        if tags is not None:
            payload["tags"] = tags
        if supersedes is not None:
            payload["supersedes"] = supersedes
        if metadata is not None:
            payload["metadata"] = metadata
        return self._post(f"/api/projects/{project_id}/decisions", payload)  # type: ignore[return-value]

    def get_decision(self, decision_id: str) -> dict[str, Any]:
        """Fetch a decision by its ID."""
        return self._get(f"/api/decisions/{decision_id}")  # type: ignore[return-value]

    def list_decisions(
        self,
        project_id: str,
        status: str | None = None,
        tags: list[str] | None = None,
        made_by: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        List decisions for a project with optional filters.

        Parameters
        ----------
        project_id:
            Owning project UUID.
        status:
            Filter by decision status (``"active"``, ``"superseded"``, etc.).
        tags:
            Filter to decisions that have *all* specified tags.
        made_by:
            Filter by agent name or ID.
        limit:
            Maximum number of results to return.

        Returns
        -------
        list[dict]
            Matching decision objects.
        """
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if tags:
            params["tags"] = ",".join(tags)
        if made_by is not None:
            params["made_by"] = made_by
        if limit is not None:
            params["limit"] = limit
        return self._get(f"/api/projects/{project_id}/decisions", params=params)  # type: ignore[return-value]

    def search_decisions(
        self,
        project_id: str,
        query: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """
        Semantic / full-text search over decisions.

        Parameters
        ----------
        project_id:
            Owning project UUID.
        query:
            Natural-language search query.
        limit:
            Maximum number of results to return (default 10).

        Returns
        -------
        list[dict]
            Ranked matching decision objects.
        """
        params = {"q": query, "limit": limit}
        return self._get(f"/api/projects/{project_id}/decisions/search", params=params)  # type: ignore[return-value]

    def supersede_decision(
        self,
        decision_id: str,
        title: str | None = None,
        description: str | None = None,
        reasoning: str | None = None,
        made_by: str | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Mark an existing decision as superseded and optionally update its fields.

        The caller should subsequently create a new decision that references the
        superseded one via *supersedes*.

        Parameters
        ----------
        decision_id:
            UUID of the decision to supersede.

        Returns
        -------
        dict
            The updated (superseded) decision object.
        """
        payload: dict[str, Any] = {"status": "superseded"}
        if title is not None:
            payload["title"] = title
        if description is not None:
            payload["description"] = description
        if reasoning is not None:
            payload["reasoning"] = reasoning
        if made_by is not None:
            payload["made_by"] = made_by
        if tags is not None:
            payload["tags"] = tags
        if metadata is not None:
            payload["metadata"] = metadata
        return self._patch(f"/api/decisions/{decision_id}", payload)  # type: ignore[return-value]

    def update_decision(
        self,
        decision_id: str,
        **fields: Any,
    ) -> dict[str, Any]:
        """
        Partially update a decision's mutable fields.

        Parameters
        ----------
        decision_id:
            UUID of the decision to update.
        **fields:
            Any combination of ``title``, ``description``, ``reasoning``,
            ``status``, ``confidence``, ``tags``, ``metadata``.

        Returns
        -------
        dict
            The updated decision object.
        """
        return self._patch(f"/api/decisions/{decision_id}", fields)  # type: ignore[return-value]

    def get_graph(self, decision_id: str, depth: int = 3) -> dict[str, Any]:
        """
        Fetch the subgraph of decisions reachable from *decision_id*.

        Parameters
        ----------
        decision_id:
            Root decision UUID.
        depth:
            How many hops to traverse (default 3).

        Returns
        -------
        dict
            A ``GraphResult``-shaped dict with ``nodes`` and ``edges``.
        """
        return self._get(f"/api/decisions/{decision_id}/graph", params={"depth": depth})  # type: ignore[return-value]

    def get_impact(self, decision_id: str) -> dict[str, Any]:
        """
        Compute downstream impact for *decision_id*.

        Returns
        -------
        dict
            An ``ImpactAnalysis``-shaped dict.
        """
        return self._get(f"/api/decisions/{decision_id}/impact")  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Context (compile)
    # ------------------------------------------------------------------

    def compile_context(
        self,
        project_id: str,
        agent_name: str,
        task_description: str,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """
        Compile relevant context for an agent about to start a task.

        DeciGraph selects recent decisions, session summaries, and unread
        notifications that are relevant to *task_description* and packages
        them into a single ``ContextPackage``.

        Parameters
        ----------
        project_id:
            Project scope.
        agent_name:
            The agent requesting context.
        task_description:
            Natural-language description of the upcoming task.
        max_tokens:
            Optional upper bound on the compiled text length (in tokens).

        Returns
        -------
        dict
            A ``ContextPackage``-shaped dict.
        """
        payload: dict[str, Any] = {
            "agent_name": agent_name,
            "task_description": task_description,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        return self._post(f"/api/projects/{project_id}/context/compile", payload)  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Distillery
    # ------------------------------------------------------------------

    def distill(
        self,
        project_id: str,
        conversation_text: str,
        agent_name: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Send a conversation transcript to the distillery for automatic
        decision and artefact extraction.

        Parameters
        ----------
        project_id:
            Project scope.
        conversation_text:
            Raw conversation text (typically the full chat history).
        agent_name:
            Optional agent name; used to attribute extracted decisions.
        session_id:
            Optional session ID to associate the result with an existing session.

        Returns
        -------
        dict
            A ``DistilleryResult``-shaped dict.
        """
        payload: dict[str, Any] = {"conversation_text": conversation_text}
        if agent_name is not None:
            payload["agent_name"] = agent_name
        if session_id is not None:
            payload["session_id"] = session_id
        return self._post(f"/api/projects/{project_id}/distillery", payload)  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Notifications
    # ------------------------------------------------------------------

    def get_notifications(
        self,
        agent_id: str,
        unread_only: bool = True,
    ) -> list[dict[str, Any]]:
        """
        Retrieve notifications for an agent.

        Parameters
        ----------
        agent_id:
            The agent UUID.
        unread_only:
            When ``True`` (default) only return unread notifications.

        Returns
        -------
        list[dict]
            Notification objects.
        """
        params = {"unread_only": "true" if unread_only else "false"}
        return self._get(f"/api/agents/{agent_id}/notifications", params=params)  # type: ignore[return-value]

    def mark_notification_read(self, notification_id: str) -> None:
        """Mark a single notification as read."""
        self._patch(f"/api/notifications/{notification_id}", {"read": True})

    def mark_all_notifications_read(self, agent_id: str) -> None:
        """Mark all notifications for an agent as read."""
        self._post(f"/api/agents/{agent_id}/notifications/mark-all-read")

    # ------------------------------------------------------------------
    # Subscriptions
    # ------------------------------------------------------------------

    def create_subscription(
        self,
        agent_id: str,
        topic: str,
        filter_tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Subscribe an agent to a topic so it receives notifications when
        matching decisions are created or updated.

        Parameters
        ----------
        agent_id:
            Subscribing agent UUID.
        topic:
            Topic string (e.g. ``"architecture"``, ``"security"``).
        filter_tags:
            Optional tag whitelist to narrow notifications.
        metadata:
            Arbitrary JSON metadata.

        Returns
        -------
        dict
            The created subscription object.
        """
        payload: dict[str, Any] = {"topic": topic}
        if filter_tags is not None:
            payload["filter_tags"] = filter_tags
        if metadata is not None:
            payload["metadata"] = metadata
        return self._post(f"/api/agents/{agent_id}/subscriptions", payload)  # type: ignore[return-value]

    def list_subscriptions(self, agent_id: str) -> list[dict[str, Any]]:
        """List all subscriptions for an agent."""
        return self._get(f"/api/agents/{agent_id}/subscriptions")  # type: ignore[return-value]

    def delete_subscription(self, subscription_id: str) -> None:
        """Remove a subscription by its ID."""
        self._delete(f"/api/subscriptions/{subscription_id}")

    # ------------------------------------------------------------------
    # Feedback
    # ------------------------------------------------------------------

    def record_feedback(
        self,
        agent_id: str,
        decision_id: str,
        was_useful: bool,
        usage_signal: str | None = None,
    ) -> None:
        """
        Record whether a decision was useful to an agent.

        Parameters
        ----------
        agent_id:
            Feedback-providing agent UUID.
        decision_id:
            Decision being rated.
        was_useful:
            ``True`` if the decision was helpful; ``False`` otherwise.
        usage_signal:
            Optional free-text signal (e.g. ``"cited in final answer"``).
        """
        payload: dict[str, Any] = {
            "decision_id": decision_id,
            "was_useful": was_useful,
        }
        if usage_signal is not None:
            payload["usage_signal"] = usage_signal
        self._post(f"/api/agents/{agent_id}/feedback", payload)

    # ------------------------------------------------------------------
    # Contradictions
    # ------------------------------------------------------------------

    def get_contradictions(
        self,
        project_id: str,
        status: str = "unresolved",
    ) -> list[dict[str, Any]]:
        """
        Retrieve detected contradictions for a project.

        Parameters
        ----------
        project_id:
            Project UUID.
        status:
            Filter by status (``"unresolved"``, ``"resolved"``, ``"ignored"``,
            or ``"all"``).

        Returns
        -------
        list[dict]
            Contradiction objects.
        """
        params: dict[str, Any] = {}
        if status != "all":
            params["status"] = status
        return self._get(f"/api/projects/{project_id}/contradictions", params=params)  # type: ignore[return-value]

    def resolve_contradiction(
        self,
        contradiction_id: str,
        status: str,
        resolved_by: str | None = None,
        resolution: str | None = None,
    ) -> None:
        """
        Update the resolution state of a contradiction.

        Parameters
        ----------
        contradiction_id:
            Contradiction UUID.
        status:
            New status: ``"resolved"`` or ``"ignored"``.
        resolved_by:
            Name or ID of the agent/human that resolved it.
        resolution:
            Free-text explanation of how it was resolved.
        """
        payload: dict[str, Any] = {"status": status}
        if resolved_by is not None:
            payload["resolved_by"] = resolved_by
        if resolution is not None:
            payload["resolution"] = resolution
        self._patch(f"/api/contradictions/{contradiction_id}", payload)

    # ------------------------------------------------------------------
    # Artifacts
    # ------------------------------------------------------------------

    def create_artifact(
        self,
        project_id: str,
        name: str,
        artifact_type: str,
        content: str = "",
        url: str | None = None,
        decision_ids: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Record a new artefact (code file, diagram, document, etc.)

        Parameters
        ----------
        project_id:
            Owning project UUID.
        name:
            Artefact name or path.
        artifact_type:
            Type label (e.g. ``"code"``, ``"diagram"``, ``"document"``).
        content:
            Inline content string.
        url:
            External URL for the artefact.
        decision_ids:
            Decisions this artefact implements or relates to.
        metadata:
            Arbitrary JSON metadata.

        Returns
        -------
        dict
            The created artefact object.
        """
        payload: dict[str, Any] = {"name": name, "artifact_type": artifact_type}
        if content:
            payload["content"] = content
        if url is not None:
            payload["url"] = url
        if decision_ids is not None:
            payload["decision_ids"] = decision_ids
        if metadata is not None:
            payload["metadata"] = metadata
        return self._post(f"/api/projects/{project_id}/artifacts", payload)  # type: ignore[return-value]

    def get_artifact(self, artifact_id: str) -> dict[str, Any]:
        """Fetch an artefact by its ID."""
        return self._get(f"/api/artifacts/{artifact_id}")  # type: ignore[return-value]

    def list_artifacts(self, project_id: str) -> list[dict[str, Any]]:
        """List all artefacts in a project."""
        return self._get(f"/api/projects/{project_id}/artifacts")  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Session Summaries
    # ------------------------------------------------------------------

    def create_session_summary(
        self,
        project_id: str,
        agent_name: str,
        summary: str,
        decision_ids: list[str] | None = None,
        artifact_ids: list[str] | None = None,
        started_at: str | None = None,
        ended_at: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Persist a session summary.

        Parameters
        ----------
        project_id:
            Owning project UUID.
        agent_name:
            Name of the agent whose session is being summarised.
        summary:
            Free-text summary of what happened in this session.
        decision_ids:
            Decisions created or referenced in this session.
        artifact_ids:
            Artefacts created or modified in this session.
        started_at:
            ISO-8601 session start time.
        ended_at:
            ISO-8601 session end time.
        metadata:
            Arbitrary JSON metadata.

        Returns
        -------
        dict
            The created session summary object.
        """
        payload: dict[str, Any] = {"agent_name": agent_name, "summary": summary}
        if decision_ids is not None:
            payload["decision_ids"] = decision_ids
        if artifact_ids is not None:
            payload["artifact_ids"] = artifact_ids
        if started_at is not None:
            payload["started_at"] = started_at
        if ended_at is not None:
            payload["ended_at"] = ended_at
        if metadata is not None:
            payload["metadata"] = metadata
        return self._post(f"/api/projects/{project_id}/sessions", payload)  # type: ignore[return-value]

    def list_session_summaries(
        self,
        project_id: str,
        agent_name: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """List session summaries, optionally filtered by agent name."""
        params: dict[str, Any] = {}
        if agent_name is not None:
            params["agent_name"] = agent_name
        if limit is not None:
            params["limit"] = limit
        return self._get(f"/api/projects/{project_id}/sessions", params=params)  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Context window / request lifetime management
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the underlying HTTP session."""
        self._session.close()

    def __enter__(self) -> "DeciGraphClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"DeciGraphClient(base_url={self.base_url!r})"
