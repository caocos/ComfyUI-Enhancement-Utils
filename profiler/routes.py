"""
Profiler HTTP API routes.

Provides an endpoint for the frontend to retrieve profiling results on page
load or refresh, so that timing badges can be restored without re-running
the workflow.

Registered on PromptServer via aiohttp route decorators.
"""

import logging

from aiohttp import web
import server

from .hooks import get_all_times, get_elapsed

logger = logging.getLogger("enhutils.profiler.routes")


@server.PromptServer.instance.routes.get("/enhutils/profiler/results")
async def get_profiler_results(_request: web.Request) -> web.Response:
    """Return the most recent profiling data.

    Response JSON:
        node_times (dict):   exec_id -> elapsed seconds (float).
        node_classes (dict): exec_id -> class_type string.
        prompt_id (str):     The prompt ID of the profiled execution.
        total_elapsed (float): Total seconds since execution started.
    """
    data = get_all_times()
    data["total_elapsed"] = get_elapsed()
    return web.json_response(data)
