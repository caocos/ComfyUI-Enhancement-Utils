"""
HTTP API routes for the ImageLoadWithSubfolders custom-folder feature.

Provides endpoints for the frontend to:
- Fetch the list of images in an arbitrary folder (for the combo widget).
- Serve an image preview from an arbitrary folder (for the node preview).
- Copy a folder image into ComfyUI's temp directory so the MaskEditor can
  open it (MaskEditor requires images to be addressable via ``/view``).

Registered on PromptServer via aiohttp route decorators (same pattern as
``monitor/routes.py``).
"""

import logging
import mimetypes
import os
import shutil

from aiohttp import web
import folder_paths
import server

from .image_load_subfolders import _resolve_folder, _scan_image_dir

logger = logging.getLogger("enhutils.image_loader.routes")


@server.PromptServer.instance.routes.get("/enhutils/image_loader/list")
async def list_folder_images(request: web.Request) -> web.Response:
    """Return the list of images in a folder for the custom-folder combo.

    Query params:
        path (str, required): Absolute path or path relative to the ComfyUI
            input directory.

    Returns:
        JSON ``{"path": <resolved>, "count": <n>, "images": [<relpaths>]}``
        on success, or a 400 error on invalid/missing path.
    """
    folder_path = request.query.get("path", "").strip()
    if not folder_path:
        return web.json_response(
            {"error": "Missing 'path' query parameter."}, status=400
        )

    try:
        resolved = _resolve_folder(folder_path)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    images = _scan_image_dir(resolved)
    logger.debug("Listed %d images in %s", len(images), resolved)

    return web.json_response({
        "path": resolved,
        "count": len(images),
        "images": images,
    })


# ── Image Preview ───────────────────────────────────────────────────────────

# Fallback MIME types for common image formats (in case the OS lookup fails).
_MIME_FALLBACKS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
}


@server.PromptServer.instance.routes.get("/enhutils/image_loader/preview")
async def preview_folder_image(request: web.Request) -> web.Response:
    """Serve an image file from a custom folder for the node preview.

    Query params:
        path (str, required): Absolute or input-relative folder path.
        image (str, required): Relative image path within the folder
            (forward-slash separated, as returned by the ``/list`` endpoint).

    Returns the raw image bytes with the appropriate content-type, or a
    400/404 error on invalid parameters.
    """
    folder_path = request.query.get("path", "").strip()
    image_rel = request.query.get("image", "").strip()

    if not folder_path or not image_rel:
        return web.json_response(
            {"error": "Missing 'path' or 'image' query parameter."}, status=400
        )

    try:
        resolved_dir = _resolve_folder(folder_path)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    # Resolve and validate the image path.
    image_path = os.path.normpath(os.path.join(resolved_dir, image_rel))

    # Guard against path traversal (the resolved file must stay inside the folder).
    # Append os.sep to the dir to prevent prefix matches like /foo matching /foobar.
    if not image_path.startswith(resolved_dir + os.sep) and image_path != resolved_dir:
        return web.json_response(
            {"error": "Image path escapes the folder."}, status=400
        )

    if not os.path.isfile(image_path):
        return web.json_response(
            {"error": f"Image not found: {image_rel}"}, status=404
        )

    # Determine content type.
    ext = os.path.splitext(image_path)[1].lower()
    content_type = mimetypes.guess_type(image_path)[0] or _MIME_FALLBACKS.get(ext, "application/octet-stream")

    return web.FileResponse(image_path, headers={"Content-Type": content_type})


# ── Copy to Temp (MaskEditor Support) ───────────────────────────────────────

# Subfolder inside ComfyUI's temp directory for folder-image copies.
_TEMP_SUBFOLDER = "enhutils_maskedit"


@server.PromptServer.instance.routes.post("/enhutils/image_loader/copy_to_temp")
async def copy_to_temp(request: web.Request) -> web.Response:
    """Copy a folder image into ComfyUI's temp directory for MaskEditor.

    MaskEditor requires images to be addressable via the ``/view`` endpoint
    (i.e. inside input/output/temp dirs). This endpoint copies the selected
    folder image into ``temp/enhutils_maskedit/<basename>`` so MaskEditor
    can open it via ``/view?type=temp&subfolder=enhutils_maskedit&filename=...``.

    JSON body:
        path (str, required): Absolute or input-relative folder path.
        image (str, required): Relative image path within the folder.

    Returns:
        JSON ``{"filename": <basename>, "subfolder": "enhutils_maskedit", "type": "temp"}``
        on success, or a 400/404 error.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body."}, status=400)

    folder_path = (body.get("path") or "").strip()
    image_rel = (body.get("image") or "").strip()

    if not folder_path or not image_rel:
        return web.json_response(
            {"error": "Missing 'path' or 'image' in request body."}, status=400
        )

    try:
        resolved_dir = _resolve_folder(folder_path)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    # Resolve and validate the source image path.
    source_path = os.path.normpath(os.path.join(resolved_dir, image_rel))

    if not source_path.startswith(resolved_dir + os.sep) and source_path != resolved_dir:
        return web.json_response(
            {"error": "Image path escapes the folder."}, status=400
        )

    if not os.path.isfile(source_path):
        return web.json_response(
            {"error": f"Image not found: {image_rel}"}, status=404
        )

    # Copy to temp directory (plain basename, overwrite if exists).
    temp_dir = os.path.join(folder_paths.get_temp_directory(), _TEMP_SUBFOLDER)
    os.makedirs(temp_dir, exist_ok=True)

    basename = os.path.basename(source_path)
    dest_path = os.path.join(temp_dir, basename)
    shutil.copy2(source_path, dest_path)

    logger.debug("Copied %s -> %s", source_path, dest_path)

    return web.json_response({
        "filename": basename,
        "subfolder": _TEMP_SUBFOLDER,
        "type": "temp",
    })
