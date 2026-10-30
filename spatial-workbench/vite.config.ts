import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Merge .env / .env.local (all keys, not just VITE_*) into process.env; real env wins.
for (const [key, value] of Object.entries(loadEnv(process.env.NODE_ENV || "development", process.cwd(), ""))) {
  process.env[key] ??= value;
}

const host = process.env.TAURI_DEV_HOST || process.env.WORKBENCH_DEV_HOST || "0.0.0.0";
const compatApiTarget = process.env.COMPAT_API_PROXY_TARGET || process.env.VITE_COMPAT_API_BASE_URL || "http://127.0.0.1:8080";
// OpenAI-compatible model endpoint used by the local Hermes agent.
// Proxied as /llm so the browser never needs CORS or LAN reachability.
// NOTE: the /v1 path segment lives in the rewrite, not the target —
// http-proxy appends the target path to the rewritten path.
const llmApiTarget = process.env.LLM_API_PROXY_TARGET || "http://127.0.0.1:2050";
const hmrClientPort = process.env.WORKBENCH_HMR_CLIENT_PORT ? Number(process.env.WORKBENCH_HMR_CLIENT_PORT) : 1420;
const hmrHost = process.env.WORKBENCH_HMR_HOST || "127.0.0.1";
const hmrProtocol = process.env.WORKBENCH_HMR_PROTOCOL || "ws";
const allowedHosts = (process.env.WORKBENCH_ALLOWED_HOSTS || "localhost,127.0.0.1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const promisePoolShim = fileURLToPath(new URL("./src/vendor/es6-promise-pool.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "es6-promise-pool": promisePoolShim,
    },
  },
  server: {
    host,
    port: 1420,
    strictPort: true,
    allowedHosts,
    hmr: {
      protocol: hmrProtocol,
      host: hmrHost,
      clientPort: Number.isFinite(hmrClientPort) ? hmrClientPort : undefined,
    },
    proxy: {
      "/api": {
        target: compatApiTarget,
        changeOrigin: true,
      },
      "/llm": {
        target: llmApiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm/, "/v1"),
      },
      // Hermes gateway via the companion API, which adds the gateway key server-side.
      "/hermes-gw": {
        target: compatApiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hermes-gw/, "/api/proxy/hermes"),
      },
    },
  },
  preview: {
    host,
    port: 1420,
    strictPort: true,
    allowedHosts,
  },
  envPrefix: ["VITE_", "TAURI_"],
});