"""
nexus-langchain
===============
LangChain / LangGraph integration for the DeciGraph multi-agent memory platform.

Exports
-------
DeciGraphMemory
    LangChain ``BaseMemory`` that compiles context from DeciGraph on every chain
    invocation and sends conversation turns to the distillery.

DeciGraphCallbackHandler
    ``BaseCallbackHandler`` that automatically captures LLM, chain, and tool
    outputs and ships them to the DeciGraph distillery.

DeciGraphCheckpointer
    LangGraph ``BaseCheckpointSaver`` that persists checkpoints as DeciGraph
    session summaries.
"""

try:
    import langchain_core  # noqa: F401
except ImportError:
    raise ImportError(
        "nexus-langchain requires langchain-core>=0.3.0. "
        "Install it with: pip install langchain-core"
    )

from .callback import DeciGraphCallbackHandler
from .checkpointer import DeciGraphCheckpointer
from .memory import DeciGraphMemory

__version__ = "0.1.0"

__all__ = [
    "DeciGraphMemory",
    "DeciGraphCallbackHandler",
    "DeciGraphCheckpointer",
]
