"""
ProfilerTiming node -- reads execution timing data from the profiler.

Sits inline in the workflow via a type-matched pass-through (any -> passthrough)
to guarantee execution ordering.  The pass-through data is unchanged.

Outputs:
    passthrough: The ``any`` input forwarded unchanged (type-matched).
    elapsed:     Seconds since the current execution started (unique per instance,
                 reflects wall-clock time at the point this node runs).
    node_time:   Seconds for a specific node or set of nodes, resolved via
                 ``node_link`` or a comma-separated list of ``node_ids``.

The node is fully cacheable -- no IS_CHANGED, no NOT_IDEMPOTENT.  If cached,
it returns stale values from the previous run, which is the intended behavior
(the profiler node should never invalidate the cache).

ID resolution for user-entered plain IDs (e.g. "54"):
    1. Try same subgraph level:  "{prefix}:{id}"
    2. Scan for nested child:    "{prefix}:*:{id}"
    3. Try root level:           "{id}"
    4. If the resolved ID is a subgraph container (no direct entry but has
       prefixed children), sum all children.

Full colon-delimited IDs (e.g. "32:234") are used verbatim.
"""

import logging

from comfy_api.latest import io

from ..profiler.hooks import get_elapsed, get_all_times

logger = logging.getLogger("enhutils.profiler.timing")


def _resolve_exec_id(raw_id: str, prefix: str, node_times: dict) -> list[str]:
    """Resolve a user-entered ID to one or more execution IDs in node_times.

    For a plain integer ID, tries the subgraph-aware resolution order.
    For an explicit colon-delimited ID, uses it directly.
    If the resolved ID is a subgraph container (prefix of other keys),
    returns all child keys for summing.

    Args:
        raw_id:     The user-entered ID string (e.g. "54" or "32:234").
        prefix:     The subgraph prefix from this node's own UNIQUE_ID
                    (e.g. "5" if UNIQUE_ID is "5:7", or "" if at root).
        node_times: The full node_times dict from the profiler.

    Returns:
        List of matching execution ID strings found in node_times.
    """
    # If the user typed a colon-delimited ID, use it directly.
    if ":" in raw_id:
        if raw_id in node_times:
            return [raw_id]
        # Check if it's a subgraph prefix.
        children = [k for k in node_times if k.startswith(raw_id + ":")]
        return children if children else []

    # Plain integer ID -- try subgraph-aware resolution.
    # 1. Same subgraph level: "{prefix}:{id}"
    if prefix:
        candidate = f"{prefix}:{raw_id}"
        if candidate in node_times:
            return [candidate]
        # Check if it's a subgraph container at this level.
        children = [k for k in node_times if k.startswith(candidate + ":")]
        if children:
            return children

    # 2. Scan for nested child: "{prefix}:*:{id}" (any key under prefix
    #    whose last segment matches).
    if prefix:
        suffix = f":{raw_id}"
        nested = [k for k in node_times
                  if k.startswith(prefix + ":") and k.endswith(suffix)]
        if nested:
            return nested

    # 3. Root level: just "{id}".
    if raw_id in node_times:
        return [raw_id]

    # 4. Root-level subgraph container.
    children = [k for k in node_times if k.startswith(raw_id + ":")]
    return children if children else []


def _resolve_linked_node(unique_id: str, prompt: dict,
                         input_name: str) -> str | None:
    """Resolve a linked input to the source node's execution ID.

    In the prompt dict, a linked input is stored as
    ``["source_exec_id", output_slot_index]``.  We read the prompt entry
    for our own node and extract the source exec ID.

    Note: ``PROMPT`` returns ``get_original_prompt()``, which contains
    entries for root-level nodes and legacy group node children (colon-
    delimited keys like ``"5:42"``).  Nodes inside new-style LiteGraph
    subgraphs are ephemeral and don't appear in the original prompt, so
    link resolution will return None for those.  The ``node_ids`` input
    can be used as a fallback in that case.

    Args:
        unique_id:  This node's execution ID (e.g. "5:7" or "7").
        prompt:     The full prompt dict (from PROMPT hidden input).
        input_name: The name of the input to resolve (e.g. "node_link").

    Returns:
        The source node's execution ID string, or None if not found.
    """
    node_entry = prompt.get(unique_id)
    if not node_entry:
        return None

    inputs = node_entry.get("inputs", {})
    input_val = inputs.get(input_name)

    # A link is [str, int] -- e.g. ["5:42", 0].
    if (isinstance(input_val, list)
            and len(input_val) == 2
            and isinstance(input_val[0], str)):
        return input_val[0]

    return None


class ProfilerTiming(io.ComfyNode):
    """Reads execution timing data from the profiler.

    Wire inline via ``any`` -> ``passthrough`` to guarantee execution order.
    The pass-through is type-matched so downstream nodes see the correct type.
    """

    PASSTHROUGH = io.MatchType.Template("passthrough")

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="EnhancementUtils_ProfilerTiming",
            display_name="Profiler Timing",
            description=(
                "Outputs execution timing from the profiler. "
                "Wire inline via 'any' -> 'passthrough' to guarantee "
                "execution order. "
                "'elapsed' is wall-clock seconds since execution started. "
                "'node_time' is the execution time of a linked node or a "
                "comma-separated list of node IDs (summed if multiple). "
                "Subgraph container IDs return the total of all nodes inside."
            ),
            category="utils",
            inputs=[
                io.MatchType.Input(
                    "any",
                    template=cls.PASSTHROUGH,
                    tooltip=(
                        "Connect any output here to place this node inline "
                        "in the workflow.  The data passes through unchanged."
                    ),
                ),
                io.AnyType.Input(
                    "node_link",
                    optional=True,
                    tooltip=(
                        "Connect any output from a node to measure that "
                        "node's execution time.  The data itself is ignored."
                    ),
                ),
                io.String.Input(
                    "node_ids",
                    default="",
                    optional=True,
                    tooltip=(
                        "Comma-separated node IDs to look up (e.g. "
                        "\"43,32:234,54\"). Plain IDs are resolved relative "
                        "to the current subgraph first, then root. "
                        "Subgraph container IDs return the total of all "
                        "nodes inside."
                    ),
                ),
            ],
            outputs=[
                io.MatchType.Output(
                    template=cls.PASSTHROUGH,
                    display_name="passthrough",
                    tooltip="The 'any' input forwarded unchanged.",
                ),
                io.Float.Output(
                    display_name="elapsed",
                    tooltip="Seconds since execution started.",
                ),
                io.Float.Output(
                    display_name="node_time",
                    tooltip=(
                        "Execution time in seconds for the resolved node(s). "
                        "Summed if multiple IDs are provided."
                    ),
                ),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.prompt],
            search_aliases=[
                "profiler timing", "execution time", "node timing",
                "benchmark", "elapsed time", "profile",
            ],
        )

    @classmethod
    def execute(cls, any, node_link=None, node_ids="",
                **kwargs) -> io.NodeOutput:
        """Read timing data from the profiler's internal state."""
        unique_id = cls.hidden.unique_id or ""
        prompt = cls.hidden.prompt or {}

        elapsed = get_elapsed()
        data = get_all_times()
        node_times = data["node_times"]

        # Extract subgraph prefix from our own UNIQUE_ID.
        # e.g. "5:7" -> prefix="5", "5:12:7" -> prefix="5:12", "7" -> prefix=""
        uid = str(unique_id)
        if ":" in uid:
            parts = uid.split(":")
            prefix = ":".join(parts[:-1])
        else:
            prefix = ""

        total_node_time = 0.0

        # ── Resolve linked node via node_link ──────────────────────
        if node_link is not None:
            linked_exec_id = _resolve_linked_node(uid, prompt, "node_link")
            if linked_exec_id:
                resolved = _resolve_exec_id(linked_exec_id, prefix, node_times)
                for eid in resolved:
                    total_node_time += node_times.get(eid, 0.0)

        # ── Resolve comma-separated node IDs ───────────────────────
        if node_ids:
            for raw_id in node_ids.split(","):
                raw_id = raw_id.strip()
                if not raw_id:
                    continue
                resolved = _resolve_exec_id(raw_id, prefix, node_times)
                for eid in resolved:
                    total_node_time += node_times.get(eid, 0.0)

        return io.NodeOutput(any, elapsed, total_node_time)
