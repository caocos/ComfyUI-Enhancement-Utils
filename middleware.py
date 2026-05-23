"""
Workaround middleware for ComfyUI's /api/view endpoint subfolder handling.

The Nodes 2.0 frontend's ``WidgetSelectDropdown.vue`` constructs thumbnail URLs
by passing the full combo value (e.g. ``subfolder/image.png``) as a single
``filename`` query parameter::

    /api/view?filename=subfolder%2Fimage.png&type=input

The backend's ``/view`` handler calls ``os.path.basename(filename)`` which
strips the subfolder portion, then looks for the file in the root input
directory -- resulting in a 404.

The correct URL format uses separate ``filename`` and ``subfolder`` params::

    /api/view?filename=image.png&subfolder=subfolder&type=input

This middleware transparently rewrites incoming ``/view`` and ``/api/view``
requests to split the path components when the ``filename`` param contains
a ``/`` and no ``subfolder`` param is present.

Upstream fix: https://github.com/Comfy-Org/ComfyUI_frontend/pull/12438
Once merged, this middleware becomes a harmless no-op (the ``subfolder``
param will already be present, so the rewrite is skipped).
"""

import logging

from aiohttp import web

import server

logger = logging.getLogger("enhutils.middleware")


@web.middleware
async def fix_view_subfolder(request: web.Request, handler):
    """Rewrite /view requests to split subfolder out of the filename param.

    Only activates when:
    - The path is ``/view`` or ``/api/view``
    - ``filename`` contains a ``/`` (i.e. has a subfolder component)
    - ``subfolder`` is not already present in the query string

    The rewrite is transparent to the handler -- it receives a cloned request
    with corrected query parameters.
    """
    if request.path in ("/view", "/api/view"):
        filename = request.rel_url.query.get("filename", "")
        if "/" in filename and "subfolder" not in request.rel_url.query:
            last_slash = filename.rfind("/")
            subfolder = filename[:last_slash]
            bare_filename = filename[last_slash + 1:]

            query = dict(request.rel_url.query)
            query["filename"] = bare_filename
            query["subfolder"] = subfolder

            new_url = request.rel_url.with_query(query)
            request = request.clone(rel_url=new_url)
            logger.debug(
                "Rewrote /view query: filename=%s subfolder=%s",
                bare_filename,
                subfolder,
            )

    return await handler(request)


# Register the middleware.  Custom node __init__.py runs before the aiohttp app
# is frozen (before AppRunner.setup()), so app.middlewares is still mutable.
server.PromptServer.instance.app.middlewares.append(fix_view_subfolder)
