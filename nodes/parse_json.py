"""
ParseJSON node -- converts a JSON string into a native Python object.

Useful for turning STRING/JSON outputs (e.g. the ``metadata``/``imagedata``
outputs of ImageLoadWithSubfolders) back into structured Python objects that
can be consumed by nodes accepting any-type inputs (e.g. rgthree's Power Puter).

Based on:
- phazei/ComfyUI-MultiLoRALoader MultiLoRA_ParseJSON
Rewritten for V3 schema.
"""

import json
import logging

from comfy_api.latest import io

logger = logging.getLogger("enhutils.parse_json")


class ParseJSON(io.ComfyNode):
    """Parses a JSON string into a native Python object (list, dict, number, etc.).

    The parsed object is emitted on an any-type output so it can be wired into
    nodes that accept arbitrary inputs but cannot decode JSON themselves.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="EnhancementUtils_ParseJSON",
            display_name="Parse JSON (EnhUtils)",
            description=(
                "Parses a JSON string into a Python object (list, dict, "
                "number, etc.) so it can be consumed by nodes that accept "
                "any-type inputs."
            ),
            category="utils",
            inputs=[
                io.String.Input(
                    "json_string",
                    force_input=True,
                    tooltip="A JSON string to parse into a Python object.",
                ),
            ],
            outputs=[
                io.AnyType.Output(
                    display_name="data",
                    tooltip="The parsed Python object.",
                ),
            ],
            search_aliases=[
                "parse json",
                "json parse",
                "json to object",
                "decode json",
            ],
        )

    @classmethod
    def execute(cls, json_string: str) -> io.NodeOutput:
        try:
            return io.NodeOutput(json.loads(json_string))
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"[Parse JSON] Invalid JSON: {exc}")
