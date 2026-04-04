"""
nexus-crewai
============
CrewAI integration for the DeciGraph multi-agent memory platform.

Exports
-------
DeciGraphCrewMemory
    CrewAI memory backend that compiles context from DeciGraph and sends task
    outputs to the distillery.

DeciGraphCrewCallback
    Task and crew lifecycle callback that captures outputs and creates
    DeciGraph session summaries automatically.
"""

from .callback import DeciGraphCrewCallback
from .memory import DeciGraphCrewMemory

__version__ = "0.1.0"

__all__ = [
    "DeciGraphCrewMemory",
    "DeciGraphCrewCallback",
]
