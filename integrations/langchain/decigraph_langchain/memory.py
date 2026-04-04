"""
nexus-langchain — Memory
========================
LangChain ``BaseMemory`` implementation backed by DeciGraph.

When an LLM chain loads memory variables, DeciGraph compiles the most relevant
decisions, session summaries, and notifications for the current agent and task.
When the chain saves context after each run, the conversation is sent to the
DeciGraph distillery for automatic decision extraction.

Usage::

    from decigraph_sdk import DeciGraphClient
    from decigraph_langchain import DeciGraphMemory
    from langchain.chains import LLMChain

    client = DeciGraphClient(base_url="http://localhost:3100")
    memory = DeciGraphMemory(
        client=client,
        project_id="proj-123",
        agent_name="coder-agent",
        task_description="Implement the auth service.",
    )
    chain = LLMChain(llm=llm, prompt=prompt, memory=memory)
"""

from __future__ import annotations

import logging
from typing import Any

from decigraph_sdk import DeciGraphClient

try:
    from langchain_core.memory import BaseMemory
    from langchain_core.messages import get_buffer_string
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "langchain-core is required for nexus-langchain. "
        "Install it with: pip install langchain-core>=0.3.0"
    ) from exc

logger = logging.getLogger(__name__)

_DEFAULT_MEMORY_KEY = "nexus_context"
_DEFAULT_INPUT_KEY = "input"
_DEFAULT_OUTPUT_KEY = "output"


class DeciGraphMemory(BaseMemory):
    """
    LangChain memory backed by DeciGraph.

    On every ``load_memory_variables`` call the relevant project decisions,
    session summaries and unread notifications are compiled into a single
    context string and injected under ``memory_key``.

    On every ``save_context`` call the human/AI exchange is appended to an
    in-process buffer.  When the buffer reaches ``distill_every`` exchanges
    (default 1) the accumulated text is sent to the DeciGraph distillery.

    Parameters
    ----------
    client:
        An initialised ``DeciGraphClient`` instance.
    project_id:
        The DeciGraph project to scope all reads and writes to.
    agent_name:
        The agent name used for context compilation and decision attribution.
    task_description:
        A description of the current task, used to rank relevant context.
    memory_key:
        The key under which compiled context is injected into LangChain's
        input variables (default ``"nexus_context"``).
    input_key:
        The key for the human input in ``save_context`` inputs.
    output_key:
        The key for the AI output in ``save_context`` outputs.
    max_tokens:
        Optional token budget passed to ``compile_context``.
    distill_every:
        Number of exchanges to accumulate before calling the distillery
        (default 1, i.e. distil after every exchange).
    return_messages:
        When ``True``, ``load_memory_variables`` also returns the raw
        decision list under ``nexus_decisions``.
    """

    client: DeciGraphClient
    project_id: str
    agent_name: str
    task_description: str
    memory_key: str = _DEFAULT_MEMORY_KEY
    input_key: str = _DEFAULT_INPUT_KEY
    output_key: str = _DEFAULT_OUTPUT_KEY
    max_tokens: int | None = None
    distill_every: int = 1
    return_messages: bool = False

    # Private state (not part of Pydantic schema — managed manually)
    _buffer: list[str]
    _exchange_count: int

    class Config:
        arbitrary_types_allowed = True

    def __init__(self, **data: Any) -> None:
        super().__init__(**data)
        object.__setattr__(self, "_buffer", [])
        object.__setattr__(self, "_exchange_count", 0)

    # ------------------------------------------------------------------
    # BaseMemory interface
    # ------------------------------------------------------------------

    @property
    def memory_variables(self) -> list[str]:
        """List of variable names this memory injects."""
        keys = [self.memory_key]
        if self.return_messages:
            keys.append("nexus_decisions")
        return keys

    def load_memory_variables(self, inputs: dict[str, Any]) -> dict[str, Any]:
        """
        Compile context from DeciGraph and return it as a dict.

        If the DeciGraph server is unreachable the method logs a warning and
        returns an empty context rather than crashing the chain.

        Parameters
        ----------
        inputs:
            The chain's current input dict.  The ``input_key`` value (if
            present) is appended to ``task_description`` to refine the query.

        Returns
        -------
        dict
            ``{memory_key: <compiled_text>}`` and optionally
            ``{"nexus_decisions": [...]}``.
        """
        task = self.task_description
        if self.input_key in inputs:
            task = f"{task}\n\nCurrent input: {inputs[self.input_key]}"

        try:
            pkg = self.client.compile_context(
                project_id=self.project_id,
                agent_name=self.agent_name,
                task_description=task,
                max_tokens=self.max_tokens,
            )
        except Exception as exc:
            logger.warning("DeciGraphMemory: failed to load context — %s", exc)
            result: dict[str, Any] = {self.memory_key: ""}
            if self.return_messages:
                result["nexus_decisions"] = []
            return result

        compiled_text: str = pkg.get("compiled_text", "")
        result = {self.memory_key: compiled_text}
        if self.return_messages:
            result["nexus_decisions"] = pkg.get("relevant_decisions", [])
        return result

    def save_context(self, inputs: dict[str, Any], outputs: dict[str, str]) -> None:
        """
        Append the latest exchange to the in-process buffer and, if the
        buffer has reached ``distill_every`` exchanges, flush it to the
        DeciGraph distillery.

        Parameters
        ----------
        inputs:
            Chain input dict (human side of the exchange).
        outputs:
            Chain output dict (AI side of the exchange).
        """
        human_text = inputs.get(self.input_key, "")
        ai_text = outputs.get(self.output_key, "")

        # Build a simple transcript line for this exchange
        exchange = f"Human: {human_text}\nAI: {ai_text}"
        buffer: list[str] = object.__getattribute__(self, "_buffer")
        buffer.append(exchange)

        count: int = object.__getattribute__(self, "_exchange_count") + 1
        object.__setattr__(self, "_exchange_count", count)

        if count % self.distill_every == 0:
            self._flush_to_distillery()

    def clear(self) -> None:
        """Clear the in-process conversation buffer."""
        object.__setattr__(self, "_buffer", [])
        object.__setattr__(self, "_exchange_count", 0)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _flush_to_distillery(self) -> None:
        """Send the accumulated buffer to the DeciGraph distillery."""
        buffer: list[str] = object.__getattribute__(self, "_buffer")
        if not buffer:
            return
        conversation_text = "\n\n".join(buffer)
        try:
            result = self.client.distill(
                project_id=self.project_id,
                conversation_text=conversation_text,
                agent_name=self.agent_name,
            )
            decisions_count = len(result.get("decisions_created", []))
            logger.debug(
                "DeciGraphMemory: distilled %d exchanges → %d decisions extracted",
                len(buffer),
                decisions_count,
            )
        except Exception as exc:
            logger.warning("DeciGraphMemory: distillery call failed — %s", exc)
        finally:
            # Clear buffer regardless of success so we don't re-send on error
            buffer.clear()
