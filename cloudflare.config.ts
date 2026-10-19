import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
  worker: {
    name: "mcp-events-hub",
    entrypoint,
    compatibilityDate: "2026-10-19",
    // enable_request_signal: without it a push stream never learns its client left, so its listener and
    // heartbeat leak (stream cancellation does not reach the Durable Object either). ctx.exports, used to
    // reach EventsHub without a binding, is on by default since 2025-11-17.
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true } },
    exports: {
      EventsHub: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      HUB_ADMIN_TOKEN: bindings.secret(),
      HUB_CLIENT_TOKENS: bindings.secret(),
      // `cf dev` runs in development mode, where a local webhook receiver over plain http must be reachable.
      HUB_ALLOW_PRIVATE_CALLBACKS: bindings.text(mode === "development" ? "1" : "0"),
    },
  },
}));
