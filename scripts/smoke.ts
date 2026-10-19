// Checks a running hub over HTTP: node scripts/smoke.ts <baseUrl>
// HUB_ADMIN_TOKEN (default dev-admin) and HUB_CLIENT_TOKEN (default dev-client) must match the hub's
// config. The webhook check needs a hub that accepts http callbacks to 127.0.0.1.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { emit, registerShop } from "../mock/service.ts";
import { MODERN_VERSION, newSecret, verify } from "../src/protocol.ts";

const base = process.argv[2]?.replace(/\/$/, "");
if (!base) {
  console.error("usage: node scripts/smoke.ts <baseUrl>");
  process.exit(1);
}
const ADMIN = process.env.HUB_ADMIN_TOKEN ?? "dev-admin";
const CLIENT = process.env.HUB_CLIENT_TOKEN ?? "dev-client";
const CREATED = "shop.order.created";
const run = randomUUID().slice(0, 8);
const alice = `alice-${run}`, bob = `bob-${run}`;
const order = (customer: string) => ({ order_id: `o-${customer}-${randomUUID().slice(0, 4)}`, customer, amount: 1200, currency: "JPY" });

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function waitFor<T>(check: () => T, what: string, timeoutMs = 5000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

let rpcId = 0;
function mcp(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT}`, "mcp-protocol-version": MODERN_VERSION, "mcp-method": method },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } } }),
    signal,
  });
}

async function result(method: string, params: Record<string, unknown> = {}) {
  const body = await (await mcp(method, params)).json();
  assert(!body.error, `${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

let secret = "";
const checks: [string, () => Promise<void>][] = [
  ["server/discover", async () => {
    const r = await result("server/discover");
    assert(r.supportedVersions.includes(MODERN_VERSION), `supportedVersions lacks ${MODERN_VERSION}`);
  }],

  ["shop registration", async () => {
    const reg = await registerShop(base, ADMIN);
    assert(reg.events.includes(CREATED), `registered events: ${reg.events}`);
    secret = reg.secret;
    const listed = await result("events/list");
    assert(listed.events.some((e: any) => e.name === CREATED), `${CREATED} not in events/list`);
  }],

  ["ingest rejects a wrong signature", async () => {
    const res = await emit(base, newSecret(), "order.created", order(alice));
    assert(res.status === 401, `status ${res.status}`);
  }],

  ["poll bootstraps, then delivers alice and not bob", async () => {
    const start = await result("events/poll", { name: CREATED, arguments: { customer: alice }, cursor: null });
    assert(start.events.length === 0, "bootstrap returned history");
    await emit(base, secret, "order.created", order(bob));
    const sent = order(alice);
    assert((await emit(base, secret, "order.created", sent)).status === 202, "alice emit not accepted");
    const page = await result("events/poll", { name: CREATED, arguments: { customer: alice }, cursor: start.cursor });
    assert(page.events.length === 1 && page.events[0].data.order_id === sent.order_id, `poll returned ${JSON.stringify(page.events)}`);
  }],

  ["push stream is active and carries a live event", async () => {
    const abort = new AbortController();
    const res = await mcp("events/stream", { name: CREATED, arguments: { customer: alice }, cursor: null }, abort.signal);
    assert(res.headers.get("content-type")?.startsWith("text/event-stream"), `content-type ${res.headers.get("content-type")}`);
    const frames: any[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i; (i = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(i + 2)) frames.push(JSON.parse(buffer.slice(0, i).replace(/^data: /, "")));
      }
    })().catch(() => {});
    try {
      await waitFor(() => frames.find((f) => f.method === "notifications/events/active"), "active frame");
      await emit(base, secret, "order.created", order(bob));
      const sent = order(alice);
      await emit(base, secret, "order.created", sent);
      const event = await waitFor(() => frames.find((f) => f.method === "notifications/events/event"), "event frame");
      assert(event.params.data.order_id === sent.order_id, `first event was ${event.params.data.order_id}, not alice's`);
    } finally {
      abort.abort();
      await reading;
    }
  }],

  ["webhook challenge, signed delivery, unsubscribe", async () => {
    const hookSecret = newSecret();
    const hits: { body: any; verified: boolean }[] = [];
    const receiver = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const signed = { id: req.headers["webhook-id"] as string, timestamp: req.headers["webhook-timestamp"] as string, signature: req.headers["webhook-signature"] as string };
      const hit = { body: JSON.parse(raw), verified: verify(hookSecret, signed, raw) };
      hits.push(hit);
      if (hit.body.type === "verification") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: hit.body.challenge }));
      else res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    const deliveries = () => hits.filter((h) => h.body.type !== "verification");
    try {
      const sub = await result("events/subscribe", { name: CREATED, arguments: { customer: alice }, delivery: { mode: "webhook", url, secret: hookSecret }, cursor: null });
      assert(/^sub_/.test(sub.id), `subscription id ${sub.id}`);
      const challenge = hits.find((h) => h.body.type === "verification");
      assert(challenge?.verified, "challenge missing or not signed with the subscription secret");

      await emit(base, secret, "order.created", order(bob));
      const sent = order(alice);
      await emit(base, secret, "order.created", sent);
      const delivery = await waitFor(() => deliveries()[0], "webhook delivery");
      assert(delivery.verified, "delivery signature does not verify");
      assert(delivery.body.data.order_id === sent.order_id, `delivered ${delivery.body.data.order_id}, not alice's`);
      await sleep(300);
      assert(deliveries().length === 1, `${deliveries().length} deliveries, expected only alice's`);

      await result("events/unsubscribe", { name: CREATED, arguments: { customer: alice }, delivery: { url } });
      await emit(base, secret, "order.created", order(alice));
      await sleep(1000);
      assert(deliveries().length === 1, "delivered after unsubscribe");
    } finally {
      receiver.closeAllConnections();
      receiver.close();
    }
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} passed against ${base}`);
process.exit(failed ? 1 : 0);
