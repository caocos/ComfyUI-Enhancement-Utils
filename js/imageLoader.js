/**
 * ImageLoader custom-folder extension.
 *
 * Enhances the ``EnhancementUtils_ImageLoadWithSubfolders`` node with:
 *
 * 1. **Dynamic combo population** -- when ``folder_path`` is set, the
 *    ``folder_image`` combo is populated from a backend endpoint that scans
 *    the folder recursively.
 *
 * 2. **Widget visibility** -- in default mode (no folder_path) only the
 *    ``image`` dropdown + upload button are shown; in custom-folder mode
 *    only ``folder_path`` + ``folder_image`` + info line are shown.
 *
 * 3. **Image preview** (legacy canvas renderer) -- when a ``folder_image``
 *    is selected, the preview thumbnail is loaded via a backend endpoint
 *    (for real folder images) or via ``/view`` (for annotated paths from
 *    MaskEditor saves or clipspace pastes). Nodes 2.0 (Vue) preview is
 *    not supported (the Vue renderer reads from an internal reactive store
 *    that is not reachable from plain JS).
 *
 * 4. **MaskEditor + Paste support** -- when "Open in MaskEditor" is clicked
 *    in folder mode, the selected folder image is copied into ComfyUI's
 *    temp directory and the ``image`` widget is set to the temp annotated
 *    path (MaskEditor requires images addressable via ``/view``). When
 *    MaskEditor saves or the user pastes via "Paste (clipspace)", the
 *    resulting annotated path is written to the ``image`` widget; a
 *    property accessor detects this and injects the path as a selectable
 *    entry in the ``folder_image`` combo. Re-opening MaskEditor on a
 *    ``clipspace-painted-masked-`` entry reloads the existing mask
 *    automatically from alpha.
 *
 * Refresh triggers:
 * - Node creation (if folder_path already has a value from a loaded workflow).
 * - ``folder_path`` widget value change (on confirm / blur).
 * - ``folder_image`` combo selection change.
 * - Global "Refresh" (R key / refresh button) via ``refreshComboInNodes``.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "EnhancementUtils_ImageLoadWithSubfolders";

// ── Cache ──────────────────────────────────────────────────────────────────

/** @type {Map<string, string[]>} Cached image lists keyed by folder path. */
const listCache = new Map();

// ── GET_CONFIG Symbol (Primitive Node Support) ─────────────────────────────

/**
 * The framework's ``GET_CONFIG`` symbol, used by Primitive nodes to read
 * combo options from an input slot's widget. Discovered at runtime via
 * ``Object.getOwnPropertySymbols`` on an input widget the framework has
 * already wired.
 *
 * @type {symbol|null}
 */
let _getConfigSymbol = null;

/**
 * Find the framework's ``GET_CONFIG`` symbol by inspecting an input slot's
 * widget for symbol-keyed properties whose value is a function returning
 * an array (the ``InputSpec`` shape).
 *
 * @param {Object} node - The LiteGraph node instance.
 * @returns {symbol|null} The ``GET_CONFIG`` symbol, or null if not found.
 */
function findGetConfigSymbol(node) {
    if (_getConfigSymbol) return _getConfigSymbol;

    for (const input of node.inputs ?? []) {
        if (!input.widget) continue;
        const symbols = Object.getOwnPropertySymbols(input.widget);
        for (const sym of symbols) {
            const val = input.widget[sym];
            if (typeof val === "function") {
                try {
                    const result = val();
                    if (Array.isArray(result)) {
                        _getConfigSymbol = sym;
                        return sym;
                    }
                } catch (_) {
                    // Skip symbols whose getter throws.
                }
            }
        }
    }
    return null;
}

/**
 * Install or re-install a ``GET_CONFIG`` override on the ``folder_image``
 * input slot's widget so that Primitive nodes read the live combo options
 * instead of the static node definition (which only has ``[""]``).
 *
 * @param {Object} node - The LiteGraph node instance.
 */
function installFolderImageGetConfig(node) {
    const sym = findGetConfigSymbol(node);
    if (!sym) return;

    const input = node.inputs?.find((i) => i.widget?.name === "folder_image");
    if (!input?.widget) return;

    const combo = findWidget(node, "folder_image");
    if (!combo) return;

    const folderWidget = findWidget(node, "folder_path");

    // Return the live options list in the InputSpec shape: [valuesArray, opts].
    // The Primitive reads [0] as the combo values.
    //
    // Guard against the global "R" refresh (reloadNodeDefs) transiently
    // clobbering our combo's options to the static [""] from the node
    // definition: that clobber happens *before* our async refresh hook
    // repopulates the list, and a connected Primitive's refreshComboInNode
    // would read [""] and reset its value to item 0. When the live options
    // are empty/[""], fall back to the last-known-good list cached by
    // folder_path so the Primitive keeps its selection.
    input.widget[sym] = () => {
        const live = combo.options?.values;
        const isEmpty =
            !Array.isArray(live) ||
            live.length === 0 ||
            (live.length === 1 && live[0] === "");

        if (isEmpty) {
            const key = (folderWidget?.value ?? "").trim();
            const cached = key ? listCache.get(key) : undefined;
            if (cached && cached.length > 0) {
                return [cached.slice(), {}];
            }
        }

        return [(live ?? [""]).slice(), {}];
    };
}

/**
 * Notify any Primitive node connected to the ``folder_image`` input slot
 * that its combo options have changed. The Primitive caches a reference to
 * the input slot's widget object and reads ``GET_CONFIG`` lazily; calling
 * its ``refreshComboInNode()`` forces it to re-read the (now overridden)
 * ``GET_CONFIG`` and rebuild its own dropdown.
 *
 * Without this, the Primitive's combo stays at the stale snapshot it took
 * during ``_onFirstConnection()`` (page load) or the last global Refresh.
 *
 * @param {Object} node - The LiteGraph node instance.
 */
function refreshConnectedPrimitives(node) {
    const input = node.inputs?.find((i) => i.widget?.name === "folder_image");
    if (!input || input.link == null) return;

    const graph = node.graph;
    if (!graph) return;

    const link = graph.links?.[input.link];
    if (!link) return;

    const sourceNode = graph.getNodeById?.(link.origin_id);
    if (sourceNode && typeof sourceNode.refreshComboInNode === "function") {
        sourceNode.refreshComboInNode();
    }
}

// ── API ────────────────────────────────────────────────────────────────────

/**
 * Fetch the image list for a folder from the backend.
 *
 * @param {string} folderPath - Absolute or input-relative folder path.
 * @param {boolean} [bypassCache=false] - If true, skip the cache and re-fetch.
 * @returns {Promise<string[]>} Sorted list of relative image paths.
 */
async function fetchImageList(folderPath, bypassCache = false) {
    if (!folderPath || !folderPath.trim()) return [];

    const key = folderPath.trim();
    if (!bypassCache && listCache.has(key)) {
        return listCache.get(key);
    }

    try {
        const resp = await api.fetchApi(
            `/enhutils/image_loader/list?path=${encodeURIComponent(key)}`
        );
        if (!resp.ok) {
            console.warn("[EnhancementUtils] ImageLoader: folder list request failed:", resp.status);
            return [];
        }
        const data = await resp.json();
        const images = data.images ?? [];
        listCache.set(key, images);
        return images;
    } catch (err) {
        console.warn("[EnhancementUtils] ImageLoader: folder list fetch error:", err);
        return [];
    }
}

/**
 * Copy a folder image into ComfyUI's temp directory so MaskEditor and
 * ``/view`` can address it.
 *
 * @param {string} folderPath - The folder_path widget value.
 * @param {string} folderImage - The relative image path within the folder.
 * @returns {Promise<{filename: string, subfolder: string, type: string}|null>}
 *     The temp file reference on success, or null on failure.
 */
async function copyToTemp(folderPath, folderImage) {
    try {
        const resp = await api.fetchApi("/enhutils/image_loader/copy_to_temp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: folderPath.trim(), image: folderImage.trim() }),
        });
        if (!resp.ok) {
            console.warn("[EnhancementUtils] ImageLoader: copy_to_temp failed:", resp.status);
            return null;
        }
        return await resp.json();
    } catch (err) {
        console.warn("[EnhancementUtils] ImageLoader: copy_to_temp error:", err);
        return null;
    }
}

// ── Widget Helpers ─────────────────────────────────────────────────────────

/**
 * Find a widget on a node by name.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string} name - Widget name.
 * @returns {Object|undefined} The widget, or undefined.
 */
function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

/**
 * Hide a widget across both LiteGraph canvas and Nodes 2.0 Vue renderers.
 *
 * @param {Object|undefined} widget - The widget to hide.
 */
function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    if (!widget.options) widget.options = {};
    widget.options.hidden = true;
    widget.computeSize = () => [0, -4];
}

/**
 * Show a widget across both renderers.
 *
 * @param {Object|undefined} widget - The widget to show.
 */
function showWidget(widget) {
    if (!widget) return;
    widget.hidden = false;
    if (!widget.options) widget.options = {};
    widget.options.hidden = false;
    widget.computeSize = undefined;
}

/**
 * Check whether ``folder_image`` currently holds a clipspace path.
 *
 * @param {string} value - The folder_image widget value.
 * @returns {boolean}
 */
function isClipspaceValue(value) {
    return typeof value === "string" && value.includes("clipspace");
}

/**
 * Check whether a value is a ComfyUI annotated path (ends with ``[type]``).
 * These come from MaskEditor saves or "Paste (clipspace)" actions.
 *
 * @param {string} value - The widget value to check.
 * @returns {boolean}
 */
function isAnnotatedPath(value) {
    return typeof value === "string" && /\s\[[^\]]+\]$/.test(value);
}

/**
 * Sync widget visibility based on whether folder_path is set.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string} folderPath - Current folder_path value.
 */
function syncWidgetVisibility(node, folderPath) {
    const hasFolder = !!(folderPath && folderPath.trim());

    const imageWidget = findWidget(node, "image");
    const uploadWidget = findWidget(node, "upload");
    const folderImageWidget = findWidget(node, "folder_image");

    if (hasFolder) {
        hideWidget(imageWidget);
        hideWidget(uploadWidget);
        showWidget(folderImageWidget);
    } else {
        showWidget(imageWidget);
        showWidget(uploadWidget);
        hideWidget(folderImageWidget);
    }

    node.graph?.setDirtyCanvas?.(true, true);
}

// ── Combo + Info Updates ───────────────────────────────────────────────────

/**
 * Replace the ``folder_image`` combo options with a new list of images,
 * reset the selection if invalid, and update the info display.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string[]} images - Sorted list of relative image paths.
 */
function applyImageList(node, images) {
    const combo = findWidget(node, "folder_image");
    if (!combo) return;

    if (!combo.options) combo.options = { values: [] };
    const finalImages = images.length > 0 ? [...images] : [""];

    // If the current value is an annotated path (from a previous MaskEditor
    // save or paste, possibly persisted in the workflow), preserve it in
    // the options so it isn't lost when the folder scan replaces the list.
    const currentValue = combo.value ?? "";
    if (isAnnotatedPath(currentValue) && !finalImages.includes(currentValue)) {
        finalImages.push(currentValue);
    }

    combo.options.values = finalImages;

    if (!finalImages.includes(combo.value)) {
        combo.value = finalImages.length > 0 ? finalImages[0] : "";
        combo.callback?.(combo.value);
    }

    // Re-assert GET_CONFIG override so Primitive nodes see updated options.
    installFolderImageGetConfig(node);

    // Kick any connected Primitive to re-read the live combo values.
    refreshConnectedPrimitives(node);
}

// ── Preview (Legacy Canvas Renderer) ───────────────────────────────────────

/**
 * Build the preview URL for a folder image via our custom endpoint.
 *
 * @param {string} folderPath - The folder_path widget value.
 * @param {string} folderImage - The folder_image widget value.
 * @returns {string} Full URL to the preview endpoint.
 */
function buildFolderPreviewUrl(folderPath, folderImage) {
    return api.apiURL(
        `/enhutils/image_loader/preview?path=${encodeURIComponent(folderPath.trim())}` +
        `&image=${encodeURIComponent(folderImage.trim())}`
    );
}

/**
 * Build the preview URL for an annotated path via the standard ``/view``
 * endpoint.
 *
 * Parses the annotated path (e.g. ``clipspace/file.png [input]`` or
 * ``file.png [temp]``) into filename, subfolder, and type components.
 *
 * @param {string} annotatedPath - The annotated path string.
 * @returns {string} Full URL to the /view endpoint.
 */
function buildAnnotatedPreviewUrl(annotatedPath) {
    let value = annotatedPath.trim();
    let type = "input";
    const typeMatch = value.match(/ \[([^\]]+)\]$/);
    if (typeMatch) {
        type = typeMatch[1];
        value = value.slice(0, -typeMatch[0].length);
    }
    let subfolder = "";
    const slashIdx = value.lastIndexOf("/");
    if (slashIdx !== -1) {
        subfolder = value.slice(0, slashIdx);
        value = value.slice(slashIdx + 1);
    }
    const params = new URLSearchParams({
        filename: value,
        subfolder: subfolder,
        type: type,
    });
    return api.apiURL(`/view?${params.toString()}`);
}

/**
 * Load an image preview and set it on the node for the legacy canvas renderer.
 *
 * Uses the custom preview endpoint for real folder images, or the standard
 * ``/view`` endpoint for clipspace images.
 *
 * @param {Object} node - The LiteGraph node instance.
 */
function updatePreview(node) {
    const folderPath = findWidget(node, "folder_path")?.value ?? "";
    const folderImage = findWidget(node, "folder_image")?.value ?? "";

    if (!folderPath.trim() || !folderImage.trim()) {
        return;
    }

    const url = isAnnotatedPath(folderImage)
        ? buildAnnotatedPreviewUrl(folderImage)
        : buildFolderPreviewUrl(folderPath, folderImage);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
        node.imgs = [img];
        node.imageIndex = null;
        node.graph?.setDirtyCanvas?.(true, true);
    };
    img.onerror = () => {
        console.warn("[EnhancementUtils] ImageLoader: preview load failed for", folderImage);
    };
    img.src = url;
}

// ── Image Widget Accessor ──────────────────────────────────────────────────

/**
 * Install a getter/setter on the ``image`` widget's ``value`` property to
 * detect when an annotated path is assigned -- either from a MaskEditor
 * save or a "Paste (clipspace)" action. Both write to
 * ``imageWidget.value`` directly (no ``.callback()``), so a property
 * accessor is the only reliable way to intercept them.
 *
 * When an annotated path (matching ``/\s\[[^\]]+\]$/``) is assigned in
 * folder mode, the setter injects it into the ``folder_image`` combo as
 * a selectable option and selects it, so ``execute()`` picks it up.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {Object} imageWidget - The ``image`` widget.
 */
function installImageWidgetAccessor(node, imageWidget) {
    // Store the underlying value on a private key.
    let _rawValue = imageWidget.value;

    // Flag set by handleFolderImageChange to suppress the setter's
    // MaskEditor-save interception during programmatic updates.
    node._settingImageFromFolder = false;

    Object.defineProperty(imageWidget, "value", {
        get() {
            return _rawValue;
        },
        set(newValue) {
            _rawValue = newValue;

            // Skip interception if this assignment came from our own code
            // (handleFolderImageChange / MaskEditor menu intercept), or if
            // not in folder mode.
            if (node._settingImageFromFolder) return;

            const folderPath = findWidget(node, "folder_path")?.value ?? "";
            if (!folderPath || !folderPath.trim()) return;

            // Only intercept annotated paths with a [type] suffix -- these
            // come from MaskEditor saves or "Paste (clipspace)" actions.
            // Plain filenames (e.g. from the image dropdown) are ignored.
            if (!isAnnotatedPath(newValue)) {
                return;
            }

            const combo = findWidget(node, "folder_image");
            if (!combo) return;

            // Replace any previously-injected annotated entry (MaskEditor
            // saves produce new timestamped filenames, pastes produce temp
            // paths -- strip old ones to keep exactly one override entry).
            if (!combo.options) combo.options = { values: [] };
            combo.options.values = combo.options.values.filter(
                (v) => !isAnnotatedPath(v)
            );
            combo.options.values.push(newValue);

            // Select it (and fire the callback to update info + preview).
            combo.value = newValue;
            combo.callback?.(newValue);

            // Sync the connected Primitive's dropdown with the new entry.
            installFolderImageGetConfig(node);
            refreshConnectedPrimitives(node);
        },
        enumerable: true,
        configurable: true,
    });
}

// ── folder_image Selection Handler ─────────────────────────────────────────

/**
 * Handle a ``folder_image`` selection change. For annotated paths (from
 * MaskEditor save or clipspace paste), sets the ``image`` widget so
 * MaskEditor can find the existing mask on re-open. For real folder images,
 * clears any stale annotated path from the ``image`` widget. Updates the
 * legacy preview in both cases.
 *
 * The actual copy-to-temp (needed for MaskEditor to open real folder images)
 * is deferred to the MaskEditor menu intercept -- no temp copies happen on
 * every selection.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {string} value - The newly selected folder_image value.
 */
function handleFolderImageChange(node, value) {
    const folderPath = findWidget(node, "folder_path")?.value ?? "";
    if (!folderPath.trim() || !value || !value.trim()) return;

    const imageWidget = findWidget(node, "image");

    // Suppress the image-widget accessor's interception while we
    // programmatically update the image widget.
    node._settingImageFromFolder = true;
    try {
        if (isAnnotatedPath(value)) {
            // Annotated entry (MaskEditor mask or pasted image): set the
            // image widget so MaskEditor's loader sees it on re-open.
            if (imageWidget) {
                imageWidget.value = value;
            }
        } else {
            // Real folder image: clear any stale annotated path from the
            // image widget so it doesn't confuse MaskEditor or execute().
            if (imageWidget && isAnnotatedPath(imageWidget.value ?? "")) {
                imageWidget.value = "";
            }
        }
    } finally {
        node._settingImageFromFolder = false;
    }

    updatePreview(node);
}

// ── Refresh Orchestration ──────────────────────────────────────────────────

/**
 * Refresh the folder_image combo and preview for a single node.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {boolean} [bypassCache=false] - Force a fresh fetch.
 */
async function refreshFolderCombo(node, bypassCache = false) {
    const folderPath = findWidget(node, "folder_path")?.value ?? "";

    if (!folderPath.trim()) {
        applyImageList(node, []);
        return;
    }

    const images = await fetchImageList(folderPath, bypassCache);
    applyImageList(node, images);

    // Trigger the selection handler for the current value to sync the
    // image widget and load the preview.
    const combo = findWidget(node, "folder_image");
    if (combo?.value && combo.value.trim()) {
        handleFolderImageChange(node, combo.value);
    }
}

/**
 * Walk a graph and its subgraphs recursively.
 *
 * @param {Object} graph - A LiteGraph graph object.
 * @param {function(Object): void} callback - Called with each node.
 */
function walkGraph(graph, callback) {
    for (const node of graph?.nodes ?? []) {
        callback(node);
        if (node.subgraph) walkGraph(node.subgraph, callback);
    }
}

// ── Extension Registration ─────────────────────────────────────────────────

/** Menu item text used by the framework for the MaskEditor entry. */
const MASK_EDITOR_MENU_TEXT = "Open in MaskEditor | Image Canvas";

app.registerExtension({
    name: "phazei.ImageLoaderSubfolders",

    /**
     * Intercept the MaskEditor context menu item for folder-mode images.
     *
     * In folder mode with a real folder image selected, MaskEditor cannot
     * open it directly (it's not addressable via ``/view``). This hook
     * copies the image to temp and sets the ``image`` widget to the temp
     * annotated path just before MaskEditor opens. For clipspace entries,
     * the ``image`` widget already holds the correct path, so no copy is
     * needed.
     *
     * @param {Function} nodeType - The node class constructor.
     * @param {Object} nodeData - The node definition from /object_info.
     */
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;

        nodeType.prototype.getExtraMenuOptions = function (_canvas, options) {
            const r = origGetExtraMenuOptions?.apply(this, arguments);

            const folderPath = findWidget(this, "folder_path")?.value ?? "";
            if (!folderPath.trim()) return r;

            const idx = options.findIndex(
                (o) => o && o.content === MASK_EDITOR_MENU_TEXT
            );
            if (idx === -1) return r;

            const originalItem = options[idx];
            const node = this;

            options[idx] = {
                content: MASK_EDITOR_MENU_TEXT,
                callback: async () => {
                    const folderImage = findWidget(node, "folder_image")?.value ?? "";
                    if (!folderImage.trim()) {
                        console.warn("[EnhancementUtils] ImageLoader: no folder image selected for MaskEditor.");
                        return;
                    }

                    // For annotated entries (clipspace masks, pasted images),
                    // the image widget already has the right path and the
                    // file is already addressable via /view -- just open
                    // MaskEditor directly.
                    if (!isAnnotatedPath(folderImage)) {
                        // Real folder image: copy to temp so MaskEditor
                        // can address it via /view.
                        const tempRef = await copyToTemp(folderPath, folderImage);
                        if (!tempRef) {
                            console.warn("[EnhancementUtils] ImageLoader: copy_to_temp failed.");
                            return;
                        }

                        const annotatedPath =
                            (tempRef.subfolder ? tempRef.subfolder + "/" : "") +
                            tempRef.filename +
                            (tempRef.type ? ` [${tempRef.type}]` : "");

                        const imageWidget = findWidget(node, "image");
                        if (imageWidget) {
                            node._settingImageFromFolder = true;
                            imageWidget.value = annotatedPath;
                            node._settingImageFromFolder = false;
                        }
                    }

                    // Open MaskEditor normally.
                    originalItem.callback();
                },
            };

            return r;
        };
    },

    /**
     * Set up each new node instance: add the info widget, wire callbacks
     * for folder_path / folder_image, install the image widget accessor,
     * sync visibility, and load the initial preview.
     *
     * @param {Object} node - The newly created node instance.
     */
    nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        // Enable MaskEditor context menu ("Open in MaskEditor").
        node.previewMediaType = "image";

        // ── folder_path callback ───────────────────────────────────────
        const folderWidget = findWidget(node, "folder_path");
        if (folderWidget) {
            const origCallback = folderWidget.callback;
            folderWidget.callback = function (value) {
                origCallback?.call(this, value);
                listCache.delete((folderWidget._prevPath ?? "").trim());
                folderWidget._prevPath = value;
                syncWidgetVisibility(node, value);
                refreshFolderCombo(node, /* bypassCache */ true);
            };
        }

        // ── folder_image callback ──────────────────────────────────────
        const folderImageCombo = findWidget(node, "folder_image");
        if (folderImageCombo) {
            const origCallback = folderImageCombo.callback;
            folderImageCombo.callback = function (value) {
                origCallback?.call(this, value);
                // Copy to temp + set image widget + preview.
                handleFolderImageChange(node, value);
            };
        }

        // ── Initial setup (deferred so injected widgets like 'upload' exist) ─
        requestAnimationFrame(() => {
            const fp = folderWidget?.value ?? "";
            syncWidgetVisibility(node, fp);

            // Install the image widget accessor to detect MaskEditor saves
            // and clipspace pastes.
            const imageWidget = findWidget(node, "image");
            if (imageWidget) {
                installImageWidgetAccessor(node, imageWidget);
            }

            // Override GET_CONFIG on the folder_image input so Primitive
            // nodes read the live combo options instead of the static [""].
            installFolderImageGetConfig(node);

            if (fp.trim()) {
                refreshFolderCombo(node);
            }
        });
    },

    /**
     * Re-fetch folder image lists on global Refresh (R key).
     * Walks all graphs including subgraphs.
     *
     * @param {Record<string, Object>} _defs - All node definitions (unused).
     */
    async refreshComboInNodes(_defs) {
        const promises = [];
        walkGraph(app.graph, (node) => {
            if (node.comfyClass !== NODE_TYPE) return;
            promises.push(refreshFolderCombo(node, /* bypassCache */ true));
        });
        await Promise.all(promises);
    },
});
