// Cloudflare entry: every request goes to one SQLite-backed Durable Object that runs the hub.
import { DurableObject } from "cloudflare:workers";
import { isIP } from "node:net";
import { createHub, envConfig, type Hub } from "./hub.ts";
import { isPrivateAddress } from "./private-net.ts";
import { openStore } from "./store.ts";

// ponytail: Workers cannot resolve DNS, so only IP literals and localhost names are refused. A hostname
// that resolves to a private address passes the guard. Upgrade: resolve over DNS-over-HTTPS and check
// the answers, or route callbacks through an egress proxy that enforces the policy.
// TODO(auth): this is weaker than the Node guard, which resolves the name and checks every address.
async function guardCallback(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host))) {
    throw new Error("callback is a non-public address");
  }
}

export class EventsHub extends DurableObject<Env> {
  hub!: Hub;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const store = openStore({ exec: (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray() });
      this.hub = createHub(store, envConfig(env), guardCallback);
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.hub.fetch(request);
  }
}

// ponytail: one global object, because the cursor is a single total order over every service's events.
// Ceiling: one Durable Object's throughput, in one region. Upgrade: one object per service or tenant,
// with the cursor scoped to it and the catalog merged across objects.
export default {
  fetch: (request, _env, ctx) => ctx.exports.EventsHub.getByName("hub").fetch(request),
} satisfies ExportedHandler<Env>;
