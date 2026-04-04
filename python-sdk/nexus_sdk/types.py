"""
DeciGraph SDK — Data Types
======================
Dataclass and TypedDict definitions for all core DeciGraph domain objects.
These mirror the JSON shapes returned by the DeciGraph REST API.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_dt(value: str | datetime | None) -> datetime | None:
    """Coerce an ISO-8601 string to datetime, or return None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------

@dataclass
class Project:
    """A DeciGraph project that owns agents, decisions, and artefacts."""

    id: str
    name: str
    description: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Project":
        return cls(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            created_at=_parse_dt(data.get("created_at")),
            updated_at=_parse_dt(data.get("updated_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

@dataclass
class Agent:
    """An AI agent registered within a DeciGraph project."""

    id: str
    project_id: str
    name: str
    role: str
    description: str = ""
    capabilities: list[str] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Agent":
        return cls(
            id=data["id"],
            project_id=data["project_id"],
            name=data["name"],
            role=data["role"],
            description=data.get("description", ""),
            capabilities=data.get("capabilities", []),
            created_at=_parse_dt(data.get("created_at")),
            updated_at=_parse_dt(data.get("updated_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# Decision
# ---------------------------------------------------------------------------

@dataclass
class Decision:
    """A recorded architectural or task-level decision."""

    id: str
    project_id: str
    title: str
    description: str
    reasoning: str
    made_by: str
    status: str = "active"  # active | superseded | deprecated
    confidence: float = 1.0
    tags: list[str] = field(default_factory=list)
    supersedes: list[str] = field(default_factory=list)
    superseded_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Decision":
        return cls(
            id=data["id"],
            project_id=data["project_id"],
            title=data["title"],
            description=data.get("description", ""),
            reasoning=data.get("reasoning", ""),
            made_by=data["made_by"],
            status=data.get("status", "active"),
            confidence=float(data.get("confidence", 1.0)),
            tags=data.get("tags", []),
            supersedes=data.get("supersedes", []),
            superseded_by=data.get("superseded_by"),
            created_at=_parse_dt(data.get("created_at")),
            updated_at=_parse_dt(data.get("updated_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# DecisionEdge
# ---------------------------------------------------------------------------

@dataclass
class DecisionEdge:
    """A directed relationship between two decisions in the graph."""

    id: str
    source_id: str
    target_id: str
    relationship: str  # e.g. "supersedes", "depends_on", "conflicts_with"
    weight: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DecisionEdge":
        return cls(
            id=data["id"],
            source_id=data["source_id"],
            target_id=data["target_id"],
            relationship=data["relationship"],
            weight=float(data.get("weight", 1.0)),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# GraphResult
# ---------------------------------------------------------------------------

@dataclass
class GraphResult:
    """Subgraph of decisions returned by a graph traversal query."""

    root_id: str
    nodes: list[Decision] = field(default_factory=list)
    edges: list[DecisionEdge] = field(default_factory=list)
    depth: int = 3

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GraphResult":
        return cls(
            root_id=data["root_id"],
            nodes=[Decision.from_dict(n) for n in data.get("nodes", [])],
            edges=[DecisionEdge.from_dict(e) for e in data.get("edges", [])],
            depth=data.get("depth", 3),
        )


# ---------------------------------------------------------------------------
# Artifact
# ---------------------------------------------------------------------------

@dataclass
class Artifact:
    """A file or data artifact tracked within a project."""

    id: str
    project_id: str
    name: str
    artifact_type: str  # e.g. "code", "diagram", "document"
    content: str = ""
    url: str | None = None
    decision_ids: list[str] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Artifact":
        return cls(
            id=data["id"],
            project_id=data["project_id"],
            name=data["name"],
            artifact_type=data.get("artifact_type", ""),
            content=data.get("content", ""),
            url=data.get("url"),
            decision_ids=data.get("decision_ids", []),
            created_at=_parse_dt(data.get("created_at")),
            updated_at=_parse_dt(data.get("updated_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# SessionSummary
# ---------------------------------------------------------------------------

@dataclass
class SessionSummary:
    """A condensed record of an agent's working session."""

    id: str
    project_id: str
    agent_name: str
    summary: str
    decision_ids: list[str] = field(default_factory=list)
    artifact_ids: list[str] = field(default_factory=list)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionSummary":
        return cls(
            id=data["id"],
            project_id=data["project_id"],
            agent_name=data["agent_name"],
            summary=data.get("summary", ""),
            decision_ids=data.get("decision_ids", []),
            artifact_ids=data.get("artifact_ids", []),
            started_at=_parse_dt(data.get("started_at")),
            ended_at=_parse_dt(data.get("ended_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# Notification
# ---------------------------------------------------------------------------

@dataclass
class Notification:
    """An event notification delivered to an agent."""

    id: str
    agent_id: str
    topic: str
    message: str
    read: bool = False
    decision_id: str | None = None
    created_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Notification":
        return cls(
            id=data["id"],
            agent_id=data["agent_id"],
            topic=data["topic"],
            message=data.get("message", ""),
            read=bool(data.get("read", False)),
            decision_id=data.get("decision_id"),
            created_at=_parse_dt(data.get("created_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# Subscription
# ---------------------------------------------------------------------------

@dataclass
class Subscription:
    """An agent's subscription to a decision topic or tag."""

    id: str
    agent_id: str
    topic: str
    filter_tags: list[str] = field(default_factory=list)
    created_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Subscription":
        return cls(
            id=data["id"],
            agent_id=data["agent_id"],
            topic=data["topic"],
            filter_tags=data.get("filter_tags", []),
            created_at=_parse_dt(data.get("created_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# Contradiction
# ---------------------------------------------------------------------------

@dataclass
class Contradiction:
    """A detected conflict between two or more decisions."""

    id: str
    project_id: str
    decision_ids: list[str]
    description: str
    status: str = "unresolved"  # unresolved | resolved | ignored
    resolved_by: str | None = None
    resolution: str | None = None
    detected_at: datetime | None = None
    resolved_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Contradiction":
        return cls(
            id=data["id"],
            project_id=data["project_id"],
            decision_ids=data.get("decision_ids", []),
            description=data.get("description", ""),
            status=data.get("status", "unresolved"),
            resolved_by=data.get("resolved_by"),
            resolution=data.get("resolution"),
            detected_at=_parse_dt(data.get("detected_at")),
            resolved_at=_parse_dt(data.get("resolved_at")),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# ContextPackage
# ---------------------------------------------------------------------------

@dataclass
class ContextPackage:
    """Compiled context returned by the /context/compile endpoint."""

    agent_name: str
    task_description: str
    relevant_decisions: list[Decision] = field(default_factory=list)
    session_summaries: list[SessionSummary] = field(default_factory=list)
    notifications: list[Notification] = field(default_factory=list)
    token_budget: int | None = None
    tokens_used: int | None = None
    compiled_text: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ContextPackage":
        return cls(
            agent_name=data["agent_name"],
            task_description=data["task_description"],
            relevant_decisions=[Decision.from_dict(d) for d in data.get("relevant_decisions", [])],
            session_summaries=[SessionSummary.from_dict(s) for s in data.get("session_summaries", [])],
            notifications=[Notification.from_dict(n) for n in data.get("notifications", [])],
            token_budget=data.get("token_budget"),
            tokens_used=data.get("tokens_used"),
            compiled_text=data.get("compiled_text", ""),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# DistilleryResult
# ---------------------------------------------------------------------------

@dataclass
class DistilleryResult:
    """Decisions and artefacts extracted by the distillery from a conversation."""

    decisions_created: list[Decision] = field(default_factory=list)
    artifacts_created: list[Artifact] = field(default_factory=list)
    session_summary: SessionSummary | None = None
    raw_extractions: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DistilleryResult":
        session = data.get("session_summary")
        return cls(
            decisions_created=[Decision.from_dict(d) for d in data.get("decisions_created", [])],
            artifacts_created=[Artifact.from_dict(a) for a in data.get("artifacts_created", [])],
            session_summary=SessionSummary.from_dict(session) if session else None,
            raw_extractions=data.get("raw_extractions", []),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# ImpactAnalysis
# ---------------------------------------------------------------------------

@dataclass
class ImpactAnalysis:
    """Downstream-impact analysis for a given decision."""

    decision_id: str
    affected_decisions: list[Decision] = field(default_factory=list)
    affected_agents: list[str] = field(default_factory=list)
    risk_score: float = 0.0
    summary: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ImpactAnalysis":
        return cls(
            decision_id=data["decision_id"],
            affected_decisions=[Decision.from_dict(d) for d in data.get("affected_decisions", [])],
            affected_agents=data.get("affected_agents", []),
            risk_score=float(data.get("risk_score", 0.0)),
            summary=data.get("summary", ""),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# FeedbackRecord
# ---------------------------------------------------------------------------

@dataclass
class FeedbackRecord:
    """Usefulness feedback an agent submits about a decision."""

    id: str
    agent_id: str
    decision_id: str
    was_useful: bool
    usage_signal: str | None = None
    created_at: datetime | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FeedbackRecord":
        return cls(
            id=data["id"],
            agent_id=data["agent_id"],
            decision_id=data["decision_id"],
            was_useful=bool(data["was_useful"]),
            usage_signal=data.get("usage_signal"),
            created_at=_parse_dt(data.get("created_at")),
        )


# ---------------------------------------------------------------------------
# Public re-exports
# ---------------------------------------------------------------------------

__all__ = [
    "Project",
    "Agent",
    "Decision",
    "DecisionEdge",
    "GraphResult",
    "Artifact",
    "SessionSummary",
    "Notification",
    "Subscription",
    "Contradiction",
    "ContextPackage",
    "DistilleryResult",
    "ImpactAnalysis",
    "FeedbackRecord",
]
