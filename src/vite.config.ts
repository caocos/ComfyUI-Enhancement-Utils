/**
 * Vite build config for ComfyUI Enhancement Utils built extensions.
 *
 * Compiles Vue-aware TypeScript modules into plain ES module bundles that
 * ComfyUI auto-loads from js/built/. Vue is bundled (not externalized)
 * since the ComfyUI frontend does not expose it globally. ComfyUI's own
 * APIs (app, api) are externalized -- they're served as shim scripts by
 * the frontend at runtime.
 *
 * Import path remapping:
 *   Source imports like "../js/utils.js" resolve to js/utils.js on disk
 *   (correct for type checking), but the built output lives in js/built/.
 *   ComfyUI serves js/ as the static root (WEB_DIRECTORY = "./js"), so
 *   at runtime "../js/utils.js" would resolve to a non-existent path.
 *   The rewriteExternalPaths plugin rewrites these to "../utils.js" in
 *   the output, which correctly resolves to "/extensions/<pack>/utils.js".
 */

import { defineConfig } from "vite";
import type { Plugin } from "vite";
import path from "path";

/**
 * Rollup plugin that rewrites external import paths from "../js/X" to "../X"
 * in the output. This accounts for the built output living one level deeper
 * (js/built/) than the source expects (src/ -> ../js/).
 */
function rewriteExternalPaths(): Plugin {
  return {
    name: "rewrite-external-paths",
    renderChunk(code: string) {
      // Rewrite imports like: from "../js/utils.js" -> from "../utils.js"
      const rewritten = code.replace(
        /from\s+["']\.\.\/js\/([^"']+)["']/g,
        'from "../$1"'
      );
      if (rewritten !== code) {
        return { code: rewritten, map: null };
      }
      return null;
    },
  };
}

export default defineConfig({
  define: {
    // Vue's source checks process.env.NODE_ENV at runtime. Replace it at
    // build time so the browser bundle doesn't reference Node.js globals.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [rewriteExternalPaths()],
  build: {
    outDir: path.resolve(__dirname, "../js/built"),
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    lib: {
      // Add entry points here as needed. Example:
      // entry: {
      //   myModule: path.resolve(__dirname, "myModule.ts"),
      // },
      entry: {},
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        // ComfyUI API shims -- served by the frontend at runtime.
        "/scripts/app.js",
        "/scripts/api.js",
        // Plain JS utilities from this package -- loaded separately by ComfyUI.
        /\.\.\/js\/.*/,
      ],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      },
    },
  },
});
