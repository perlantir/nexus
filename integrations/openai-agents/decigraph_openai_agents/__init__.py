"""
nexus-openai-agents
===================
OpenAI Agents SDK integration for the DeciGraph multi-agent memory platform.

Exports
-------
DeciGraphAgentHooks
    Lifecycle hooks (``on_start``, ``on_end``, ``on_tool_output``,
    ``on_handoff``) that compile DeciGraph context, capture tool outputs, and
    send conversations to the distillery automatically.
"""

from .hooks import DeciGraphAgentHooks

__version__ = "0.1.0"

__all__ = [
    "DeciGraphAgentHooks",
]
