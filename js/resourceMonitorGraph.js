/**
 * Resource Monitor - Historical Graph Popup.
 *
 * Provides a hover popup that displays a sparkline/area chart of historical
 * metric data when the user mouses over a monitor bar. Uses Canvas 2D for
 * rendering -- no external charting library required.
 *
 * Supports two display modes:
 * - **Single mode**: One chart for the hovered metric (shown on hover).
 * - **All mode**: A grid of small charts for every active metric (toggled on click).
 *
 * Exported API:
 * - MetricHistory: Ring buffer class for storing time-series data.
 * - showGraphPopup(bar, history, options): Show single-chart popup.
 * - showMultiGraphPopup(anchor, metrics): Show all-charts grid popup.
 * - hideGraphPopup(): Hide the popup.
 * - isPopupPinned(): Check if the popup is pinned (click-toggled).
 * - setPopupDirty(): Mark the popup for re-render on next animation frame.
 *
 * @module resourceMonitorGraph
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Single-chart popup dimensions. */
const SINGLE_WIDTH = 290;
const SINGLE_HEIGHT = 150;

/** Multi-chart grid: dimensions per mini-chart cell. */
const CELL_WIDTH = 240;
const CELL_HEIGHT = 120;
const GRID_GAP = 6;
const GRID_PAD = 8;
/** Max columns in the multi-chart grid. */
const MAX_COLS = 4;

/** Chart area padding inside a single chart (or a cell). */
const PAD = { top: 28, right: 12, bottom: 24, left: 40 };
/** Tighter padding for mini-charts in grid mode. */
const MINI_PAD = { top: 22, right: 8, bottom: 18, left: 32 };

/** Color used for axis lines and labels. */
const AXIS_COLOR = "rgba(255, 255, 255, 0.35)";
const LABEL_COLOR = "rgba(255, 255, 255, 0.7)";
const LABEL_FONT = "10px monospace";
const MINI_LABEL_FONT = "9px monospace";
const VALUE_FONT = "bold 13px monospace";
const MINI_VALUE_FONT = "bold 11px monospace";

// ═══════════════════════════════════════════════════════════════════════════
// MetricHistory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Time-series metric data store backed by a plain array.
 *
 * Each entry is {time: number (ms epoch), value: number}.
 *
 * When capacity > 0, old entries are trimmed on push to stay within the limit.
 * When capacity === 0, the array grows without limit (until manually cleared).
 */
export class MetricHistory {
    /**
     * @param {number} capacity - Max data points to retain (0 = unlimited).
     */
    constructor(capacity) {
        /** @type {Array<{time: number, value: number}>} */
        this._data = [];
        /** @type {number} */
        this._capacity = capacity;
    }

    /** Current number of stored entries. */
    get size() { return this._data.length; }

    /**
     * Push a new data point. Trims oldest entries if over capacity.
     * @param {number} value - The metric value.
     * @param {number} [time] - Timestamp in ms (defaults to Date.now()).
     */
    push(value, time = Date.now()) {
        this._data.push({ time, value });
        if (this._capacity > 0 && this._data.length > this._capacity) {
            // Remove the excess oldest entries.
            this._data.splice(0, this._data.length - this._capacity);
        }
    }

    /**
     * Return all stored entries in chronological order (oldest first).
     * @returns {Array<{time: number, value: number}>}
     */
    toArray() { return this._data; }

    /**
     * Change capacity. Trims oldest entries if the new capacity is smaller.
     * @param {number} newCapacity - New max entries (0 = unlimited).
     */
    resize(newCapacity) {
        this._capacity = newCapacity;
        if (newCapacity > 0 && this._data.length > newCapacity) {
            this._data.splice(0, this._data.length - newCapacity);
        }
    }

    /**
     * Bulk-load entries (e.g., fetched from the backend).
     * Replaces all existing data. Trims to capacity if needed.
     * @param {Array<{time: number, value: number}>} entries
     */
    loadFromArray(entries) {
        if (this._capacity > 0 && entries.length > this._capacity) {
            this._data = entries.slice(-this._capacity);
        } else {
            this._data = entries.slice();
        }
    }

    /** Clear all stored data. */
    clear() { this._data = []; }

    /** Get the most recent entry, or null if empty. */
    latest() {
        const len = this._data.length;
        return len > 0 ? this._data[len - 1] : null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Popup Singleton
// ═══════════════════════════════════════════════════════════════════════════

/** @type {HTMLDivElement|null} */
let popupEl = null;
/** @type {HTMLCanvasElement|null} */
let canvasEl = null;
/** @type {CanvasRenderingContext2D|null} */
let ctx = null;
/** @type {number|null} */
let rafId = null;
/** @type {boolean} */
let dirty = false;

/**
 * Whether the popup is currently "pinned" (toggled by clicking a bar).
 * When pinned, mouseenter/mouseleave on individual bars do not affect it.
 */
let pinned = false;

/** Current display mode: "single" or "multi". */
let displayMode = "single";

/** State for single-chart mode. */
let singleState = {
    /** @type {MetricHistory|null} */
    history: null,
    color: "#0C86F4",
    label: "",
    unit: "%",
    yMax: 100,
    /** @type {string|null} */
    extraLine: null,
};

/**
 * State for multi-chart grid mode.
 * Each entry may have a `getExtra` function that is called at render time
 * to produce a dynamic extraLine string (e.g., session cost).
 * @type {Array<{key: string, history: MetricHistory, color: string, label: string, unit: string, yMax: number, extraLine: string|null, getExtra: function|null}>}
 */
let multiState = [];

/** Current canvas logical dimensions (varies by mode). */
let canvasW = SINGLE_WIDTH;
let canvasH = SINGLE_HEIGHT;

/**
 * Lazily create the popup DOM elements.
 */
function ensurePopup() {
    if (popupEl) return;

    popupEl = document.createElement("div");
    popupEl.className = "enhutils-graph-popup";
    popupEl.style.display = "none";

    canvasEl = document.createElement("canvas");
    popupEl.appendChild(canvasEl);

    document.body.appendChild(popupEl);
}

/**
 * Resize the popup and canvas to given logical dimensions.
 * @param {number} w - Logical width.
 * @param {number} h - Logical height.
 */
function resizeCanvas(w, h) {
    canvasW = w;
    canvasH = h;
    const dpr = window.devicePixelRatio || 1;

    popupEl.style.width = w + "px";
    popupEl.style.height = h + "px";

    canvasEl.width = w * dpr;
    canvasEl.height = h * dpr;
    canvasEl.style.width = w + "px";
    canvasEl.style.height = h + "px";

    ctx = canvasEl.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ── Render Loop ────────────────────────────────────────────────────────────

/**
 * Animation frame callback. Re-draws the chart(s) if marked dirty.
 */
function renderLoop() {
    if (dirty && popupEl?.style.display !== "none") {
        if (displayMode === "single") {
            drawSingleChart();
        } else {
            drawMultiChart();
        }
        dirty = false;
    }
    rafId = requestAnimationFrame(renderLoop);
}

/**
 * Start the render loop if not already running.
 */
function startRenderLoop() {
    if (rafId == null) {
        rafId = requestAnimationFrame(renderLoop);
    }
}

/**
 * Stop the render loop.
 */
function stopRenderLoop() {
    if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Single Chart Drawing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Draw a single sparkline/area chart (full-size popup).
 */
function drawSingleChart() {
    if (!ctx || !singleState.history) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    drawChartInRegion(
        0, 0, canvasW, canvasH,
        singleState.history.toArray(),
        singleState.color,
        singleState.label,
        singleState.unit,
        singleState.yMax,
        singleState.extraLine,
        PAD, LABEL_FONT, VALUE_FONT,
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi Chart Drawing (Grid)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Draw the grid of mini-charts for all metrics.
 */
function drawMultiChart() {
    if (!ctx || multiState.length === 0) return;
    ctx.clearRect(0, 0, canvasW, canvasH);

    const count = multiState.length;
    const cols = Math.min(count, MAX_COLS);
    const rows = Math.ceil(count / cols);

    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = GRID_PAD + col * (CELL_WIDTH + GRID_GAP);
        const y = GRID_PAD + row * (CELL_HEIGHT + GRID_GAP);
        const m = multiState[i];

        // Evaluate dynamic extra line (e.g., session cost) at render time.
        const extra = m.getExtra ? m.getExtra() : m.extraLine;

        drawChartInRegion(
            x, y, CELL_WIDTH, CELL_HEIGHT,
            m.history.toArray(),
            m.color, m.label, m.unit, m.yMax, extra,
            MINI_PAD, MINI_LABEL_FONT, MINI_VALUE_FONT,
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared Chart Renderer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Draw a single sparkline/area chart within a given rectangular region.
 *
 * @param {number} rx - Region X offset.
 * @param {number} ry - Region Y offset.
 * @param {number} rw - Region width.
 * @param {number} rh - Region height.
 * @param {Array<{time: number, value: number}>} data - Time-series data.
 * @param {string} color - Chart line/fill color.
 * @param {string} label - Metric label.
 * @param {string} unit - Unit ("%", "W", "\u00B0").
 * @param {number} yMax - Maximum Y-axis value.
 * @param {string|null} extraLine - Extra info text below chart.
 * @param {Object} pad - Padding object {top, right, bottom, left}.
 * @param {string} labelFont - Font for axis labels.
 * @param {string} valueFont - Font for header values.
 */
function drawChartInRegion(rx, ry, rw, rh, data, color, label, unit, yMax, extraLine, pad, labelFont, valueFont) {
    // Chart area bounds (inside padding).
    const cx = rx + pad.left;
    const cy = ry + pad.top;
    const cw = rw - pad.left - pad.right;
    const ch = rh - pad.top - pad.bottom;

    // ── Cell background (subtle, for grid mode separation) ─────────
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(rx + 1, ry + 1, rw - 2, rh - 2, 4);
    } else {
        ctx.rect(rx + 1, ry + 1, rw - 2, rh - 2);
    }
    ctx.fill();

    // ── Background grid ────────────────────────────────────────────
    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 0.5;

    for (let i = 0; i <= 4; i++) {
        const y = cy + (ch * i) / 4;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.lineTo(cx + cw, y);
        ctx.stroke();
    }

    // Y-axis labels.
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = labelFont;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
        const y = cy + (ch * i) / 4;
        const val = yMax - (yMax * i) / 4;
        let lbl;
        if (unit === "W") {
            lbl = Math.round(val) + "W";
        } else if (unit === "\u00B0") {
            lbl = Math.round(val) + "\u00B0";
        } else {
            lbl = Math.round(val) + "%";
        }
        ctx.fillText(lbl, cx - 4, y);
    }

    // ── Data line & fill ───────────────────────────────────────────
    if (data.length < 2) {
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = valueFont;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Collecting\u2026", cx + cw / 2, cy + ch / 2);
        drawChartHeader(cx, cy, cw, label, unit, data, color, valueFont);
        return;
    }

    const tMin = data[0].time;
    const tMax = data[data.length - 1].time;
    const tRange = Math.max(tMax - tMin, 1);

    /** Map a data point to canvas coordinates within this region. */
    const toXY = (pt) => ({
        x: cx + ((pt.time - tMin) / tRange) * cw,
        y: cy + ch - (Math.min(Math.max(pt.value, 0), yMax) / yMax) * ch,
    });

    // Filled area.
    ctx.beginPath();
    const p0 = toXY(data[0]);
    ctx.moveTo(p0.x, cy + ch);
    ctx.lineTo(p0.x, p0.y);
    for (let i = 1; i < data.length; i++) {
        const p = toXY(data[i]);
        ctx.lineTo(p.x, p.y);
    }
    const pLast = toXY(data[data.length - 1]);
    ctx.lineTo(pLast.x, cy + ch);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.18);
    ctx.fill();

    // Line.
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < data.length; i++) {
        const p = toXY(data[i]);
        ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Current value dot.
    ctx.beginPath();
    ctx.arc(pLast.x, pLast.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // ── X-axis time labels ─────────────────────────────────────────
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = labelFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const tickCount = 4;
    for (let i = 0; i <= tickCount; i++) {
        const t = tMin + (tRange * i) / tickCount;
        const x = cx + (cw * i) / tickCount;
        const secsAgo = Math.round((tMax - t) / 1000);
        let tLabel;
        if (secsAgo >= 60) {
            tLabel = Math.round(secsAgo / 60) + "m";
        } else if (secsAgo === 0) {
            tLabel = "now";
        } else {
            tLabel = secsAgo + "s";
        }
        ctx.fillText(tLabel, x, cy + ch + 4);
    }

    // ── Header (label + current value) ─────────────────────────────
    drawChartHeader(cx, cy, cw, label, unit, data, color, valueFont);

    // ── Extra line (e.g., session cost) ────────────────────────────
    if (extraLine) {
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = labelFont;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(extraLine, cx + cw / 2, cy + ch + 14);
    }
}

/**
 * Draw the header row at the top of a chart (metric label + current value).
 * @param {number} cx - Chart area left X.
 * @param {number} cy - Chart area top Y.
 * @param {number} cw - Chart area width.
 * @param {string} label - Metric label.
 * @param {string} unit - Unit string.
 * @param {Array<{time: number, value: number}>} data - Time-series data.
 * @param {string} color - Chart color.
 * @param {string} font - Font for header text.
 */
function drawChartHeader(cx, cy, cw, label, unit, data, color, font) {
    // Label (top-left, above the chart area).
    ctx.fillStyle = "#fff";
    ctx.font = font;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, cx, cy - 4);

    // Current value (top-right, above the chart area).
    if (data.length > 0) {
        const current = data[data.length - 1].value;
        let valStr;
        if (unit === "W") {
            valStr = Math.round(current) + "W";
        } else if (unit === "\u00B0") {
            valStr = Math.round(current) + "\u00B0C";
        } else {
            valStr = current.toFixed(1) + "%";
        }
        ctx.fillStyle = color;
        ctx.textAlign = "right";
        ctx.fillText(valStr, cx + cw, cy - 4);
    }
}

/**
 * Convert a hex color string to rgba.
 * @param {string} hex - e.g., "#0C86F4"
 * @param {number} alpha
 * @returns {string}
 */
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Positioning
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Position the popup relative to an anchor element.
 * Prefers below, falls back to above if no room.
 * @param {HTMLElement} anchor - The element to anchor to.
 * @param {number} popW - Popup width.
 * @param {number} popH - Popup height.
 */
function positionPopup(anchor, popW, popH) {
    const rect = anchor.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - popW / 2;
    let top = rect.bottom + 6;

    // Clamp to viewport.
    if (left < 4) left = 4;
    if (left + popW > window.innerWidth - 4) {
        left = window.innerWidth - popW - 4;
    }
    if (top + popH > window.innerHeight - 4) {
        top = rect.top - popH - 6;
    }

    popupEl.style.left = left + "px";
    popupEl.style.top = top + "px";
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Show the single-chart graph popup anchored to a monitor bar element.
 * Does nothing if the popup is currently pinned.
 *
 * @param {HTMLElement} barElement - The .enhutils-monitor element to anchor to.
 * @param {MetricHistory} history - History data to render.
 * @param {Object} options
 * @param {string} options.color - Chart line/fill color (hex).
 * @param {string} options.label - Metric label.
 * @param {string} [options.unit="%"] - Unit for Y-axis.
 * @param {number} [options.yMax=100] - Maximum Y-axis value.
 * @param {string|null} [options.extraLine=null] - Extra info line.
 */
export function showGraphPopup(barElement, history, options) {
    if (pinned) return; // Don't interrupt pinned popup.
    ensurePopup();

    displayMode = "single";
    singleState.history = history;
    singleState.color = options.color || "#0C86F4";
    singleState.label = options.label || "";
    singleState.unit = options.unit || "%";
    singleState.yMax = options.yMax || 100;
    singleState.extraLine = options.extraLine || null;

    resizeCanvas(SINGLE_WIDTH, SINGLE_HEIGHT);
    positionPopup(barElement, SINGLE_WIDTH, SINGLE_HEIGHT);
    popupEl.style.display = "block";

    dirty = true;
    startRenderLoop();
}

/**
 * Show the multi-chart grid popup with all active metrics.
 *
 * @param {HTMLElement} anchorElement - Element to anchor the popup to (e.g., monitor root).
 * @param {Array<{key: string, history: MetricHistory, color: string, label: string, unit: string, yMax: number, extraLine: string|null, getExtra: function|null}>} metrics
 *   Array of metric descriptors. Only metrics with history.size >= 1 should be included.
 *   If `getExtra` is provided, it is called at render time to produce a dynamic extraLine.
 */
export function showMultiGraphPopup(anchorElement, metrics) {
    ensurePopup();

    displayMode = "multi";
    pinned = true;
    multiState = metrics;

    // Calculate grid dimensions.
    const count = metrics.length;
    const cols = Math.min(count, MAX_COLS);
    const rows = Math.ceil(count / cols);
    const totalW = GRID_PAD * 2 + cols * CELL_WIDTH + (cols - 1) * GRID_GAP;
    const totalH = GRID_PAD * 2 + rows * CELL_HEIGHT + (rows - 1) * GRID_GAP;

    resizeCanvas(totalW, totalH);
    positionPopup(anchorElement, totalW, totalH);
    popupEl.style.display = "block";

    dirty = true;
    startRenderLoop();
}

/**
 * Hide the graph popup and unpin it.
 * @param {boolean} [force=false] - If true, hide even when pinned.
 */
export function hideGraphPopup(force = false) {
    if (pinned && !force) return; // Don't hide pinned popup on mouseleave.
    if (popupEl) {
        popupEl.style.display = "none";
    }
    pinned = false;
    stopRenderLoop();
}

/**
 * Check if the popup is currently pinned (click-toggled to show all).
 * @returns {boolean}
 */
export function isPopupPinned() {
    return pinned;
}

/**
 * Mark the popup as needing a re-render (call after new data arrives).
 */
export function setPopupDirty() {
    dirty = true;
}
