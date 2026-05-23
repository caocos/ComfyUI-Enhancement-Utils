# ComfyUI Nodes 2.0 Migration — Coding Agent Resource Guide

## Goal

Convert custom ComfyUI nodes that have JavaScript frontend code (LiteGraph-specific) so they work on **both** the legacy LiteGraph renderer **and** the new Nodes 2.0 Vue-based renderer. The backend Python code does NOT need to change — only the JS frontend extensions need attention.

---

## Background: What Changed

ComfyUI's frontend has two rendering modes:
1. **Legacy (LiteGraph):** Canvas2D-based rendering via a customized LiteGraph.js. Widgets are drawn on canvas or injected as DOM elements.
2. **Nodes 2.0 (Vue):** Vue 3 component-based rendering. Each node is a Vue component. Widgets are mapped to Vue components via a **widget registry**.

Simple nodes with only Python-defined inputs/outputs work on both renderers automatically — the Python config generates widget definitions that both renderers understand. **The problem is JavaScript extensions** that:
- Monkey-patch `LGraphNode` prototypes or `LGraphCanvas` methods
- Use `getCustomWidgets()` to register custom canvas-drawn widgets
- Directly manipulate canvas context (`ctx.fillRect`, etc.) in `draw()` methods
- Hook into LiteGraph-specific callbacks (`onDrawForeground`, `onDrawBackground`, etc.)
- Access `LiteGraph.Themes` or other LiteGraph globals

## How Nodes 2.0 Handles Legacy JS

The Vue renderer has **three fallback strategies** for widgets it doesn't have a native Vue component for:

1. **`WidgetLegacy`** — Wraps legacy canvas-drawn widgets. Creates a `<canvas>` element, calls the widget's original `draw()` method on it, and forwards pointer events. This is the catch-all for custom widgets that draw on canvas.
2. **`WidgetDOM`** — Wraps DOM widgets (created via `node.addDOMWidget()`). Takes the existing HTML element and mounts it into the Vue component tree.
3. **Native Vue widgets** — Registered in the widget registry (`widgetRegistry.ts`). These are the proper Vue implementations for standard types (string, int, float, combo, boolean, textarea, button, color, etc.).

The routing logic is in `NodeWidgets.vue`:
```
const vueComponent = getComponent(widget.type) || (widget.isDOMWidget ? WidgetDOM : WidgetLegacy)
```

**Key insight:** If your custom widget type is NOT in the registry and is NOT a DOM widget, it falls through to `WidgetLegacy`, which tries to draw it on a mini-canvas. This works for some cases but can break for widgets that rely on node-level callbacks or prototype patching.

---

## Official Documentation URLs

The coding agent should read these pages for API reference:

### Core Extension Development Docs
- **Extension overview:** https://docs.comfy.org/custom-nodes/overview
- **JS Extensions (how to register):** https://docs.comfy.org/custom-nodes/js/javascript_overview
- **Comfy Hooks (beforeRegisterNodeDef, setup, etc.):** https://docs.comfy.org/custom-nodes/js/javascript_hooks
- **Comfy Objects (app, canvas, graph, LiteGraph):** https://docs.comfy.org/custom-nodes/js/javascript_objects_and_hijacking
- **Context Menu Migration Guide:** https://docs.comfy.org/custom-nodes/js/context-menu-migration
- **Annotated Examples:** https://docs.comfy.org/custom-nodes/js/javascript_examples
- **Settings API:** https://docs.comfy.org/custom-nodes/js/javascript_settings
- **Toast API:** https://docs.comfy.org/custom-nodes/js/javascript_toast

### V3 Schema (Python backend — for reference, not the primary task)
- **V3 Migration Guide:** https://docs.comfy.org/custom-nodes/v3_migration

### Nodes 2.0 Overview
- **Official Nodes 2.0 docs:** https://docs.comfy.org/interface/nodes-2
- **Blog post with rationale:** https://blog.comfy.org/p/comfyui-node-2-0

### Reference Repos / Templates
- **Official Vue extension template:** https://github.com/jtydhr88/ComfyUI_frontend_vue_basic
- **Official React extension template:** https://github.com/Comfy-Org/ComfyUI-React-Extension-Template
- **ComfyUI Frontend repo (Vue source):** https://github.com/Comfy-Org/ComfyUI_frontend
- **DeepWiki — Extension Architecture:** https://deepwiki.com/Comfy-Org/ComfyUI_frontend/5.2-core-extensions
- **DeepWiki — Vue Node Rendering:** https://deepwiki.com/Comfy-Org/ComfyUI_frontend

---

## Local File Paths for the Coding Agent

### Frontend Source (Vue/TS — authoritative for Nodes 2.0 behavior)
All paths under: `D:\AITools\ComfyUI_frontend\`

#### Architecture Overview
- `AGENTS.md` — Comprehensive repo guidelines, coding conventions, architecture constraints
- `src/CLAUDE.md` — Points to AGENTS.md

#### Vue Node Rendering System (how Nodes 2.0 renders nodes)
- `src/renderer/extensions/vueNodes/components/NodeWidgets.vue` — **CRITICAL: Widget routing logic.** This is where widgets are matched to Vue components. Shows the fallback chain: registry → DOM widget → Legacy widget.
- `src/renderer/extensions/vueNodes/components/LGraphNode.vue` — The main Vue component wrapping each node
- `src/renderer/extensions/vueNodes/components/NodeContent.vue` — Node body content
- `src/renderer/extensions/vueNodes/components/NodeHeader.vue` — Node header
- `src/renderer/extensions/vueNodes/components/NodeFooter.vue` — Node footer
- `src/renderer/extensions/vueNodes/components/NodeSlots.vue` — Input/output slots

#### Widget Registry (maps widget type strings → Vue components)
- `src/renderer/extensions/vueNodes/widgets/registry/widgetRegistry.ts` — **CRITICAL: Widget type registry.** Defines which widget types get native Vue components, aliases, and which are "essential." If a custom widget type isn't here, it falls back to WidgetLegacy.

#### Legacy Widget Compatibility Layer
- `src/renderer/extensions/vueNodes/widgets/components/WidgetLegacy.vue` — **CRITICAL: How legacy canvas-drawn widgets are wrapped.** Creates a mini-canvas, calls the widget's `draw()` method, and forwards pointer events via `CanvasPointer`.
- `src/renderer/extensions/vueNodes/widgets/components/WidgetDOM.vue` — How DOM widgets are mounted in Vue nodes.

#### Built-in Vue Widget Components (reference implementations)
- `src/renderer/extensions/vueNodes/widgets/components/WidgetButton.vue`
- `src/renderer/extensions/vueNodes/widgets/components/WidgetInputNumber.vue`
- `src/renderer/extensions/vueNodes/widgets/components/WidgetInputText.vue`
- `src/renderer/extensions/vueNodes/widgets/components/WidgetSelect.vue`
- `src/renderer/extensions/vueNodes/widgets/components/WidgetTextarea.vue`
- `src/renderer/extensions/vueNodes/widgets/components/WidgetToggleSwitch.vue`
- `src/renderer/extensions/vueNodes/widgets/components/WidgetColorPicker.vue`
- `src/renderer/extensions/vueNodes/widgets/components/WidgetMarkdown.vue`

#### Widget Composables (Vue logic for each widget type)
- `src/renderer/extensions/vueNodes/widgets/composables/useComboWidget.ts`
- `src/renderer/extensions/vueNodes/widgets/composables/useFloatWidget.ts`
- `src/renderer/extensions/vueNodes/widgets/composables/useIntWidget.ts`
- `src/renderer/extensions/vueNodes/widgets/composables/useStringWidget.ts`
- `src/renderer/extensions/vueNodes/widgets/composables/useBooleanWidget.ts`
- `src/renderer/extensions/vueNodes/widgets/composables/useTextareaWidget.ts`

#### Extension System
- `src/stores/extensionStore.ts` — How extensions are registered and managed
- `src/types/comfy.ts` — **CRITICAL: `ComfyExtension` interface.** Defines all available hooks: `beforeRegisterNodeDef`, `setup`, `init`, `getCustomWidgets`, `nodeCreated`, `getCanvasMenuItems`, `getNodeMenuItems`, etc.
- `src/extensions/core/customWidgets.ts` — Core extension that handles CustomCombo, PrimitiveInt, PrimitiveFloat nodes
- `src/extensions/core/index.ts` — Index of all core extensions

#### DOM Widget System (key for migration strategy)
- `src/scripts/domWidget.ts` — **CRITICAL for DOM widget approach.** Contains the full `addDOMWidget()` implementation (added to `LGraphNode.prototype` at bottom of file), the `DOMWidget` and `ComponentWidget` interfaces, `DOMWidgetOptions` with all available options (`hideOnZoom`, `getValue`, `setValue`, `getMinHeight`, `getMaxHeight`, `getHeight`, `onDraw`, `margin`, `afterResize`), the `BaseDOMWidgetImpl` class showing how DOM widgets handle drawing/visibility/sizing in LiteGraph, and the `ComponentWidgetImpl` class for Vue component widgets. The `addDOMWidget(name, type, element, options)` signature is at the bottom of the file.
- `src/scripts/domWidget.test.ts` — Tests for DOM widget behavior
- `src/stores/domWidgetStore.ts` — Pinia store managing DOM widget registration/lifecycle
- `src/scripts/widgets.ts` — Standard widget constructors (INT, FLOAT, STRING, COMBO, etc.). Shows how `getCustomWidgets()` return values are consumed. Reference for understanding the widget constructor signature that custom widgets must match.

#### Core Extensions Using DOM Widgets (reference implementations)
- `src/extensions/core/uploadImage.ts` — Uses input spec manipulation for image upload widgets
- `src/extensions/core/uploadAudio.ts` — Audio upload widget
- `src/extensions/core/webcamCapture.ts` — Webcam capture, likely uses DOM widget for video element
- `src/extensions/core/noteNode.ts` — Note node, may use DOM widget for text area
- `src/extensions/core/imageCompare.ts` — Image comparison widget
- `src/extensions/core/imageCrop.ts` — Image crop widget
- `src/extensions/core/painter.ts` — Painter widget (drawing canvas)

#### App and API
- `src/scripts/app.ts` — Main `ComfyApp` class. Contains `registerExtension()`, `#invokeExtensions`, and the extension lifecycle.

### Backend Source (Python — for understanding node definitions)
All paths under: `D:\AITools\StabilityMatrixData\Packages\ComfyUI\`

- `comfy_api/` — V3 schema API (if migrating Python too)
- `custom_nodes/` — Where custom node packs live

---

## Build Tooling for Vue/React Extensions

When a custom node needs rich interactive UI beyond what plain JS + DOM widgets can provide, the recommended approach is to author Vue or React components and compile them with **Vite** into a bundled JS file. Vite is what ComfyUI's own frontend uses (`vite.config.mts` at the frontend repo root), and it's what both official extension templates are built on.

### When You Need a Build Step

Not every node needs one. The decision tree:
- **Plain JS with `app.registerExtension()` and standard/DOM widgets:** No build step. Files in `web/` or `js/` are served directly.
- **Vue/React components for complex interactive widgets, panels, or overlays:** Build step required. Source in a `src/` or `ui/` directory, Vite compiles to `dist/` or `web/`, which is what ComfyUI actually serves.

### Hybrid Repos

A single custom node repo can mix both approaches. ComfyUI serves all JS files from the node's web directory regardless of how they were produced. Some extensions can be hand-written plain JS, while others are compiled Vue/React components — all coexisting in the same package. The built files are just IIFE or ES module bundles that call `app.registerExtension()` at the end of the day, same as plain JS.

Plain JS and built components share the same browser runtime, so they can interact: a Vue bundle can register a widget type or expose utilities that plain JS extensions reference, and vice versa. Load order matters — control it via file naming (alphabetical within a node pack) or have the plain JS side defer until the built component is available.

### End User Experience

Users clone the repo and it just works — as long as the built output files are committed to the repo. No build step required on the user's end. The workflow for developers:
1. Source files in `src/` or `ui/` directory
2. `npm run build` compiles to `dist/` or `web/`
3. Commit both source and built output
4. Users clone and go, ComfyUI serves the built JS

### Official Extension Templates

Both templates use Vite with TypeScript:

**Vue template:** `https://github.com/jtydhr88/ComfyUI_frontend_vue_basic`
- Uses `@vitejs/plugin-vue`, PrimeVue components, vue-i18n
- Demonstrates a drawing board widget inside a custom node
- Build output served from the node's web directory

**React template (official Comfy-Org):** `https://github.com/Comfy-Org/ComfyUI-React-Extension-Template`
- Source lives in `ui/` directory, builds to `dist/`
- Includes GitHub Actions workflow for automated builds
- Demonstrates a dashboard/statistics panel
- Structure:
  ```
  MyNode/
  ├── __init__.py          # Python backend
  ├── pyproject.toml       # Registry metadata
  ├── dist/                # Built output (committed, served by ComfyUI)
  └── ui/                  # React/Vite source
      ├── src/
      │   ├── main.tsx     # Entry point, calls registerExtension()
      │   └── App.tsx      # Main component
      ├── vite.config.ts
      └── package.json
  ```

### Local Reference: ComfyUI Frontend Vite Config
- `D:\AITools\ComfyUI_frontend\vite.config.mts` — The main frontend's own Vite config. Useful reference for build settings, externalization patterns, and plugin configuration in the ComfyUI context.

---

## Custom Nodes to Migrate

These are the custom node packs with JavaScript frontend code that needs attention:

### 1. ComfyUI-Prompt-Stash
**Path:** `D:\AITools\StabilityMatrixData\Packages\ComfyUI\custom_nodes\ComfyUI-Prompt-Stash\`
**JS files:**
- `js/prompt_stash_manager.js` — Heavy JS: registers extension with `beforeRegisterNodeDef`, monkey-patches `onNodeCreated`, dynamically adds widgets (`addWidget`), custom fetch calls, uses `app.extensionManager.toast`, `computeSize` override
- `js/multi_button.js` — **Custom widget via `getCustomWidgets()`**: Registers `MULTI_BUTTON` widget type. Uses `LiteGraph.Themes`, canvas drawing (`ctx.beginPath`, `ctx.fillRect`, etc.), pointer event handling via widget's `mouse()` method, `computeSize()`, `draw()` — all very LiteGraph-specific
- `js/prompt_stash_passthrough.js` — Extension registration
- `js/prompt_stash_saver.js` — Extension registration
- `js/utils.js` — Shared utilities

**Migration difficulty:** HIGH — `multi_button.js` is a fully custom canvas-drawn widget. `prompt_stash_manager.js` does extensive prototype patching.

---

## Migration Patterns & Strategies

### Pattern 1: Detect the Active Renderer

To make code work on both renderers, you can check which renderer is active:

```javascript
// Check if Nodes 2.0 (Vue) renderer is active by looking for Vue-rendered node containers.
// These have a data-node-id attribute that only exists in the Vue renderer.
function isVueRenderer() {
    return document.querySelector("[data-node-id]") !== null;
}
```

The safest approach is to write code that **doesn't depend on the renderer** — use only the official extension hooks and avoid prototype patching.

### Pattern 2: Replace Prototype Patching with Official Hooks

**Before (deprecated):**
```javascript
const origOnNodeCreated = nodeType.prototype.onNodeCreated;
nodeType.prototype.onNodeCreated = function() {
    origOnNodeCreated?.apply(this, arguments);
    // custom logic
};
```

**After (recommended):**
```javascript
// Use useChainCallback from ComfyUI frontend
import { useChainCallback } from '@/composables/functional/useChainCallback';

nodeType.prototype.onNodeCreated = useChainCallback(
    nodeType.prototype.onNodeCreated,
    function() {
        // custom logic
    }
);
```

Or even better, use the `nodeCreated` hook on the extension itself:
```javascript
app.registerExtension({
    name: "my.extension",
    nodeCreated(node, app) {
        if (node.comfyClass === "MyNodeType") {
            // custom logic
        }
    }
});
```

### Pattern 3: Replace Context Menu Monkey-Patching

**Before:**
```javascript
const original = LGraphCanvas.prototype.getCanvasMenuOptions;
LGraphCanvas.prototype.getCanvasMenuOptions = function() {
    const options = original.apply(this, arguments);
    options.push({ content: "My Action", callback: () => {} });
    return options;
};
```

**After:**
```javascript
app.registerExtension({
    name: "my.extension",
    getCanvasMenuItems(canvas) {
        return [null, { content: "My Action", callback: () => {} }];
    }
});
```

See full guide: https://docs.comfy.org/custom-nodes/js/context-menu-migration

### Pattern 4: Custom Canvas-Drawn Widgets

This is the hardest case. Options:

1. **Let WidgetLegacy handle it** — If the widget implements `draw(ctx, node, width, y, height)`, the Vue renderer will wrap it in a mini-canvas. Test thoroughly — pointer events may not map correctly.

2. **Convert to a DOM widget** — Instead of drawing on canvas, create an HTML element via `node.addDOMWidget()`. DOM widgets work on both renderers (WidgetDOM wraps them in Vue).

3. **Create a proper Vue component** — The most work but the best result. Register a new widget type in the registry or use the extension API to provide a Vue component.

### Pattern 5: Widget `computeSize` and Layout

In the Vue renderer, `WidgetLegacy.vue` handles sizing via:
```
// Priority: computedHeight > computeLayoutSize > computeSize
if (widgetInstance.computedHeight) {
    height = widgetInstance.computedHeight
} else if (widgetInstance.computeLayoutSize) {
    height = widgetInstance.computeLayoutSize(node).minHeight
} else if (widgetInstance.computeSize) {
    height = widgetInstance.computeSize(width)[1]
}
```

Ensure your custom widgets implement at least `computeSize(width)` returning `[width, height]`.

---

## Key Technical Details

### Widget Type Resolution Chain
In `NodeWidgets.vue` (line ~370):
```typescript
const vueComponent = getComponent(widget.type) || (widget.isDOMWidget ? WidgetDOM : WidgetLegacy)
```

### Registered Widget Types (from widgetRegistry.ts)
These types have native Vue components and will NOT fall through to WidgetLegacy:
- `button` / `BUTTON`
- `string` / `STRING` / `text`
- `int` / `INT`
- `float` / `FLOAT` / `number` / `slider` / `gradientslider`
- `boolean` / `BOOLEAN` / `toggle`
- `combo` / `COMBO` / `asset`
- `color` / `COLOR`
- `textarea` / `TEXTAREA` / `multiline` / `customtext`
- `chart` / `CHART`
- `imagecompare` / `IMAGECOMPARE`
- `galleria` / `GALLERIA`
- `markdown` / `MARKDOWN` / `progressText`
- `legacy` (explicit legacy wrapper)
- `audiorecord` / `AUDIO_RECORD`
- `audioUI` / `AUDIOUI`
- `load3D` / `LOAD_3D`
- `imagecrop` / `IMAGECROP`
- `boundingbox` / `BOUNDING_BOX`
- `curve` / `CURVE`
- `painter` / `PAINTER`

Any widget type NOT in this list (like `MULTI_BUTTON`) will be wrapped by WidgetLegacy.

### Extension Hooks Available (from ComfyExtension interface)
- `init(app)` — Early init, before nodes added
- `setup(app)` — After app fully running
- `addCustomNodeDefs(defs, app)` — Modify node definitions
- `getCustomWidgets(app)` — Return custom widget constructors
- `beforeRegisterNodeDef(nodeType, nodeData, app)` — Modify node type before registration
- `beforeRegisterVueAppNodeDefs(defs, app)` — Modify defs for Vue app specifically
- `registerCustomNodes(app)` — Register additional node types
- `loadedGraphNode(node, app)` — After node loaded from graph
- `nodeCreated(node, app)` — After node constructor runs
- `beforeConfigureGraph(graphData, missingNodeTypes, app)`
- `afterConfigureGraph(missingNodeTypes, app)`
- `getCanvasMenuItems(canvas)` — Add canvas right-click menu items
- `getNodeMenuItems(node)` — Add node right-click menu items
- `getSelectionToolboxCommands(selectedItem)` — Add selection toolbox items

### Deprecated Patterns to Avoid
- Monkey-patching `LGraphCanvas.prototype.*`
- Monkey-patching `LGraphNode.prototype.*`  
- Directly accessing `app.canvas` internals
- Using `LiteGraph.Themes.current` (use CSS variables instead in Vue)
- Hijacking `app` methods

---

## Critical Pitfalls (Learned from Migration Experience)

These issues were discovered during actual migration work and are not obvious from the docs or source alone.

### `setDirtyCanvas()` and `graph.change()` Are No-Ops in Vue Mode

In the LiteGraph canvas renderer, `graph.setDirtyCanvas(true, true)` forces a repaint and `graph.change()` marks the graph as dirty. **Neither of these affects the Vue renderer.** Vue positions, badges, and widgets are driven entirely by Vue's reactivity system (`layoutStore`, reactive props, computed refs). If your extension relies on `setDirtyCanvas()` to trigger visual updates, it will appear to do nothing in Nodes 2.0.

### Node Position: Setter vs Index Mutation

The Vue renderer tracks node positions via a `pos` setter on `LGraphNode` that routes changes through a centralized `layoutStore` (backed by a Yjs CRDT document). The setter triggers a `customRef` which Vue watches to update the DOM `transform: translate(...)`.

```javascript
// CORRECT: Triggers the pos setter → layoutStore → Vue re-render
node.pos = [x, y];

// BROKEN in Vue: Mutates the internal _pos array directly, bypasses the setter.
// LiteGraph canvas will update (on next setDirtyCanvas), but Vue will NOT.
node.pos[0] = x;
node.pos[1] = y;
```

Any extension that programmatically moves nodes (arrange, align, snap-to-grid, etc.) **must** use full array assignment. Reading `node.pos[0]` for calculations is fine.

### Dual Vue Runtime Problem

If you bundle Vue in your extension (via Vite or similar), you get a **separate Vue instance** from the one the frontend uses. Vue's reactivity system is per-instance: a `ref()` created by your bundled Vue is invisible to the frontend's `computed()` and `toValue()`.

This means:
- `node.badges.push(() => myRef.value)` — the getter will be called, but changing `myRef.value` will NOT trigger the frontend's badge `computed` to re-evaluate. The frontend's `toValue()` calls your function but doesn't track your ref as a dependency.
- You cannot use Vue `ref()`/`computed()` to drive reactive updates in the frontend's components from an external extension.

**Workarounds:**
- Use plain getter functions that do live data lookups (no refs). Accept that the getter only fires when the frontend re-evaluates for other reasons.
- For dynamic updates (like a live timer), use **direct DOM manipulation** via `[data-node-id]` selectors instead of the badges API.
- For static-after-set data, the getter approach works fine — the value is correct whenever the frontend calls it.

### `node.badges` Array Is Not Fully Reactive

Unlike `node.widgets`, `node.inputs`, and `node.outputs` (which receive `shallowReactive` + `Object.defineProperty` interception), the `node.badges` array is a plain reference captured by `extractVueNodeData`. Mutations to the raw array (push, splice) from external JS do **not** reliably trigger the frontend's Vue reactive proxy.

For badge-like overlays that need dynamic updates, **direct DOM manipulation** is the reliable approach:

```javascript
// Find a node's DOM element in the Vue renderer
const nodeEl = document.querySelector(`[data-node-id="${node.id}"]`);
if (nodeEl) {
    // The node container is position:absolute with isolation:isolate,
    // so absolutely-positioned children work.
    const badge = document.createElement("div");
    badge.style.cssText = "position:absolute; bottom:-20px; right:8px; ...";
    badge.textContent = "1.23s";
    nodeEl.appendChild(badge);
}
```

### `nodeCreated` Fires Before `node.graph` Is Set

The `nodeCreated` extension hook fires inside the `LGraphNode` constructor, **before** `graph.add(node)` sets `node.graph`. Any code that needs `node.graph` (e.g., determining if the node is in a subgraph, computing execution IDs) must defer to `afterConfigureGraph` or use a guard:

```javascript
nodeCreated(node) {
    // node.graph is null/undefined here!
    // Do NOT call getUniqueIdFromNode(node) or access node.graph.isRootGraph
    
    // Safe: set up data structures, attach badge getters, add widgets
    node._myExtensionData = {};
    node.badges.push(myBadgeGetter);
},

afterConfigureGraph() {
    // node.graph is fully set here.
    walkGraph(app.graph, (node) => {
        // Safe to access node.graph, compute exec IDs, etc.
    });
}
```

### Tab Switching Destroys Node Instances

When the user switches between ComfyUI's workflow tabs (internal tabs, not browser tabs), **all `LGraphNode` instances are destroyed and recreated.** The sequence is:
1. `LGraph.clear()` — sets `_nodes = []`, old instances become garbage
2. `LGraph.configure(graphData)` — calls `LiteGraph.createNode()` → `new LGraphNode()` for every node
3. `nodeCreated` fires for each new node
4. `afterConfigureGraph` fires after all nodes are created

Any custom properties attached to node instances (e.g., `node._myState`, `node._enhutils_profiler_badge`) are **lost**. Store persistent data in module-level Maps keyed by node ID or execution ID, and re-attach to fresh instances in `nodeCreated` / `afterConfigureGraph`.

### Subgraph Navigation Destroys Vue Components

When the user enters or exits a subgraph, the Vue renderer destroys the current `GraphNodeManager` and creates a new one for the target graph. All Vue node components are unmounted and remounted. If you injected DOM elements (badges, overlays) into node containers, they are destroyed.

Listen for the `litegraph:set-graph` event on `app.canvas.canvas` to detect subgraph navigation and re-inject DOM content after Vue remounts:

```javascript
app.canvas.canvas.addEventListener("litegraph:set-graph", () => {
    // Defer to let Vue mount the new node elements
    setTimeout(() => {
        // Re-inject DOM badges/overlays here
    }, 50);
});
```

Similarly, `afterConfigureGraph` can use `requestAnimationFrame` to defer DOM manipulation until after Vue has rendered.

---

## Testing Checklist

After migration, test each node under both renderers:

1. Toggle Nodes 2.0 ON in ComfyUI settings
2. Verify all widgets render correctly
3. Verify widget interactions (clicks, drags, value changes)
4. Verify context menus work
5. Verify node sizing/layout is correct
6. Toggle Nodes 2.0 OFF
7. Verify everything still works in legacy mode
8. Test workflow save/load with mixed renderer usage

### Additional Nodes 2.0-Specific Tests

9. **Programmatic node movement** — If the extension repositions nodes (arrange, align, snap), verify nodes visually move in Vue mode, not just in the data model
10. **Tab switching** — Run a workflow, switch to a different workflow tab and back. Verify any persistent visual state (badges, overlays) survives the round trip
11. **Subgraph navigation** — Enter a subgraph, then exit. Verify overlays/badges re-appear on the root graph nodes
12. **Live updates** — If the extension updates node visuals during execution (progress, timers), verify they tick in Vue mode, not just LiteGraph canvas mode
13. **DOM cleanup** — If the extension injects DOM elements, verify they are cleaned up when nodes are removed or when switching renderers