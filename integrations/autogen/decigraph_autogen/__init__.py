"""
decigraph-autogen
=============
Microsoft AutoGen integration for the DeciGraph multi-agent memory platform.

Exports
-------
DeciGraphAutoGenMemory
    Memory backend for AutoGen agents that compiles context from DeciGraph,
    buffers messages for periodic distillation, and creates session summaries.
"""

from .memory import DeciGraphAutoGenMemory

__version__ = "0.1.0"

__all__ = [
    "DeciGraphAutoGenMemory",
]
