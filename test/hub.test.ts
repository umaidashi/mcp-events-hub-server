import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { emit, registerShop, shop } from "../mock/service.ts";
import { startHub } from "../src/hub.ts";
import { ErrorCode, LEGACY_VERSIONS, MODERN_VERSION, newSecret, verify } from "../src/protocol.ts";

const ADMIN = "admin";
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CREATED = "shop.order.created";

let hub: Awaited<ReturnType<typeof startHub>>;
let secret: string;
let receiver: Awaited<ReturnType<typeof startReceiver>>;

before(async () => {
  hub = await startHub({
    port: 0, db: ":memory:", adminToken: ADMIN, clientTokens: "tester:t1",
    allowPrivateCallbacks: true, retryBaseMs: 20, heartbeatMs: 200,
  });
  ({ secret } = await registerShop(hub.url, ADMIN));
  receiver = await startReceiver();
});

after(async () => {
  await hub.close();
  await receiver.close();
});

let orderSeq = 0;
const order = (customer: string) => ({ order_id: `ord_${++orderSeq}`, customer, amount: 1200, currency: "JPY" });

async function post(body: unknown, headers: Record<string, string> = {}, url = hub.url) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t1", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() };
}

let rpcId = 0;
function rpc(method: string, params: Record<string, unknown> = {}, opts: { legacy?: boolean; url?: string } = {}) {
  const meta = opts.legacy ? {} : { _meta: { [VERSION_META]: MODERN_VERSION } };
  const headers = opts.legacy ? {} : { "mcp-protocol-version": MODERN_VERSION, "mcp-method": method };
  return post({ jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, ...meta } }, headers, opts.url);
}

async function waitFor<T>(check: () => T, message: string, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out: ${message}`);
    await sleep(10);
  }
}

async function openStream(id: number, params: Record<string, unknown>) {
  const abort = new AbortController();
  const res = await fetch(`${hub.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t1", "mcp-protocol-version": MODERN_VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "events/stream", params: { ...params, _meta: { [VERSION_META]: MODERN_VERSION } } }),
    signal: abort.signal,
  });
  const frames: any[] = [];
  let read = 0;
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let i; (i = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(i + 2)) {
        frames.push(JSON.parse(buffer.slice(0, i).replace(/^data: /, "")));
      }
    }
  })().catch(() => {});
  return {
    res,
    async next(method: string) {
      return waitFor(() => {
        while (read < frames.length) {
          const frame = frames[read++];
          if (frame.method === method) return frame;
        }
      }, `stream frame ${method}`);
    },
    close: () => abort.abort(),
  };
}

type Hit = { headers: IncomingHttpHeaders; body: any; verified: boolean };
type Hook = { url: string; secret: string; statuses: number[]; echo: boolean; verifications: Hit[]; deliveries: Hit[] };

async function startReceiver() {
  const hooks = new Map<string, Hook>();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const hook = hooks.get(req.url!)!;
    const signed = { id: req.headers["webhook-id"] as string, timestamp: req.headers["webhook-timestamp"] as string, signature: req.headers["webhook-signature"] as string };
    const hit = { headers: req.headers, body: JSON.parse(raw), verified: verify(hook.secret, signed, raw) };
    if (hit.body.type === "verification") {
      hook.verifications.push(hit);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: hook.echo ? hit.body.challenge : "wrong" }));
      return;
    }
    hook.deliveries.push(hit);
    res.writeHead(hook.statuses.shift() ?? 200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  return {
    hook(opts: { statuses?: number[]; echo?: boolean } = {}): Hook {
      const path = `/hook/${++n}`;
      const hook = { url: base + path, secret: newSecret(), statuses: opts.statuses ?? [], echo: opts.echo ?? true, verifications: [], deliveries: [] };
      hooks.set(path, hook);
      return hook;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const subscribe = (hook: Hook, customer: string, extra: Record<string, unknown> = {}) =>
  rpc("events/subscribe", {
    name: CREATED, arguments: { customer }, delivery: { mode: "webhook", url: hook.url, secret: hook.secret }, cursor: null, ...extra,
  });

describe("MCP transport", () => {
  test("legacy initialize negotiates a legacy version and issues no session", async () => {
    const { status, headers, body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }, { legacy: true });
    assert.equal(status, 200);
    assert.equal(body.result.protocolVersion, "2025-06-18", "requested legacy version echoed");
    assert.deepEqual(body.result.capabilities.events, { listChanged: false }, "events capability advertised");
    assert.equal(body.result.serverInfo.name, "mcp-events-hub");
    assert.equal(headers.get("mcp-session-id"), null, "no Mcp-Session-Id");
    const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" }, { legacy: true });
    assert.equal(unknown.body.result.protocolVersion, LEGACY_VERSIONS[0], "unknown version falls back to newest legacy");
  });

  test("JSON-RPC notifications get 202", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
  });

  test("modern server/discover", async () => {
    const { status, body } = await rpc("server/discover");
    assert.equal(status, 200);
    assert.equal(body.result.resultType, "complete");
    assert.ok(body.result.supportedVersions.includes(MODERN_VERSION));
    assert.deepEqual(body.result.capabilities, { tools: {}, events: { listChanged: false } });
    assert.equal(body.result._meta["io.modelcontextprotocol/serverInfo"].name, "mcp-events-hub");
  });

  test("unsupported modern version is HTTP 400 -32022 with the supported list", async () => {
    const { status, body } = await post(
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { [VERSION_META]: "2099-01-01" } } },
      { "mcp-protocol-version": "2099-01-01" });
    assert.equal(status, 400);
    assert.equal(body.error.code, ErrorCode.UnsupportedProtocolVersion);
    assert.ok(body.error.data.supported.includes(MODERN_VERSION), "supported versions listed");
    assert.equal(body.error.data.requested, "2099-01-01");
  });

  test("header that disagrees with the body is HTTP 400 -32020", async () => {
    const params = { _meta: { [VERSION_META]: MODERN_VERSION } };
    const version = await post({ jsonrpc: "2.0", id: 1, method: "ping", params }, { "mcp-protocol-version": "2025-06-18" });
    assert.equal(version.status, 400, "MCP-Protocol-Version mismatch");
    assert.equal(version.body.error.code, ErrorCode.HeaderMismatch);
    const method = await post({ jsonrpc: "2.0", id: 2, method: "ping", params }, { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" });
    assert.equal(method.status, 400, "Mcp-Method mismatch");
    assert.equal(method.body.error.code, ErrorCode.HeaderMismatch);
  });

  test("unknown method is 404 in the modern era and 200 in legacy", async () => {
    const modern = await rpc("nope/nope");
    assert.equal(modern.status, 404);
    assert.equal(modern.body.error.code, ErrorCode.MethodNotFound);
    const legacy = await rpc("nope/nope", {}, { legacy: true });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.error.code, ErrorCode.MethodNotFound);
  });

  test("client auth, Origin and HTTP method guards", async () => {
    const missing = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "" });
    assert.equal(missing.status, 401, "missing token rejected");
    assert.equal(missing.headers.get("www-authenticate"), "Bearer");
    const wrong = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer nope" });
    assert.equal(wrong.status, 401, "wrong token rejected");
    const origin = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
    assert.equal(origin.status, 403, "foreign Origin rejected");
    const local = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://localhost:3000" });
    assert.equal(local.status, 200, "localhost Origin allowed");
    assert.equal((await fetch(`${hub.url}/mcp`)).status, 405, "GET not allowed");
  });
});

describe("service registry and ingest", () => {
  const put = (id: string, body: unknown, token = ADMIN) =>
    fetch(`${hub.url}/services/${id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  test("registration requires the admin token and a valid id", async () => {
    assert.equal((await put("other", shop, "wrong")).status, 401, "bad admin token");
    assert.equal((await put("Bad_Id", shop)).status, 400, "invalid service id");
  });

  test("a filter without a matching payload field is rejected", async () => {
    const bad = structuredClone(shop);
    bad.events[0].inputSchema.properties = { region: { type: "string" } };
    const res = await put("bad", bad);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error, "error message returned");
    const { body } = await rpc("events/list");
    assert.ok(!body.result.events.some((e: any) => e.name.startsWith("bad.")), "rejected service not published");
  });

  test("re-registration keeps the service secret", async () => {
    const again = await registerShop(hub.url, ADMIN);
    assert.equal(again.secret, secret);
    assert.deepEqual(again.events, ["shop.order.created", "shop.order.shipped"]);
  });

  test("ingest checks signature, event name and payload", async () => {
    assert.equal((await emit(hub.url, newSecret(), "order.created", order("x"))).status, 401, "wrong secret");
    assert.equal((await emit(hub.url, secret, "order.refunded", order("x"))).status, 404, "unknown event");
    const invalid = await emit(hub.url, secret, "order.created", { ...order("x"), amount: "12" });
    assert.equal(invalid.status, 400, "payload invalid");
    assert.ok((invalid.body as any).errors.length > 0, "validation errors returned");
  });

  test("a repeated eventId is stored once", async () => {
    const start = (await rpc("events/poll", { name: CREATED, arguments: { customer: "dup" }, cursor: null })).body.result.cursor;
    const first = await emit(hub.url, secret, "order.created", order("dup"), "evt_dup");
    const second = await emit(hub.url, secret, "order.created", order("dup"), "evt_dup");
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { seq: (first.body as any).seq, duplicate: true });
    const { body } = await rpc("events/poll", { name: CREATED, arguments: { customer: "dup" }, cursor: start });
    assert.equal(body.result.events.length, 1, "poll sees one event");
  });

  test("events/list publishes namespaced events with all delivery modes", async () => {
    const { body } = await rpc("events/list");
    const created = body.result.events.find((e: any) => e.name === CREATED);
    assert.ok(created, "shop.order.created listed");
    assert.ok(body.result.events.some((e: any) => e.name === "shop.order.shipped"));
    assert.deepEqual(created.delivery, ["webhook", "push", "poll"]);
    assert.deepEqual(created.payloadSchema, shop.events[0].payloadSchema);
  });
});

describe("poll", () => {
  const poll = (customer: string, cursor: string | null, extra: Record<string, unknown> = {}) =>
    rpc("events/poll", { name: CREATED, arguments: { customer }, cursor, ...extra });

  test("null cursor bootstraps with no events", async () => {
    await emit(hub.url, secret, "order.created", order("boot"));
    const { body } = await poll("boot", null);
    assert.deepEqual(body.result.events, [], "history is not replayed");
    assert.equal(typeof body.result.cursor, "string");
    assert.equal(body.result.hasMore, false);
    assert.equal(body.result.resultType, "complete");
  });

  test("delivers matching events after the cursor and nothing else", async () => {
    const start = (await poll("p-alice", null)).body.result.cursor;
    await emit(hub.url, secret, "order.created", order("p-bob"));
    const sent = order("p-alice");
    const { body: emitted } = await emit(hub.url, secret, "order.created", sent, "evt_poll");
    const { body } = await poll("p-alice", start);
    assert.equal(body.result.events.length, 1, "filtered event is not delivered");
    assert.deepEqual(body.result.events[0].data, sent);
    assert.equal(body.result.events[0].eventId, "evt_poll");
    assert.ok(!("cursor" in body.result.events[0]), "poll events carry no cursor");
    assert.ok(Number(body.result.cursor) >= (emitted as any).seq, "cursor advanced");
    const again = await poll("p-alice", body.result.cursor);
    assert.deepEqual(again.body.result.events, [], "nothing redelivered");
  });

  test("maxEvents pages with hasMore", async () => {
    const start = (await poll("p-many", null)).body.result.cursor;
    for (let i = 0; i < 3; i++) await emit(hub.url, secret, "order.created", order("p-many"));
    const first = (await poll("p-many", start, { maxEvents: 2 })).body.result;
    assert.equal(first.events.length, 2);
    assert.equal(first.hasMore, true);
    const second = (await poll("p-many", first.cursor, { maxEvents: 2 })).body.result;
    assert.equal(second.events.length, 1, "remaining event on the next page");
    assert.equal(second.hasMore, false);
  });

  test("rejects unknown events, bad arguments and foreign cursors", async () => {
    const unknown = await rpc("events/poll", { name: "shop.nope", arguments: {}, cursor: null });
    assert.equal(unknown.body.error.code, ErrorCode.NotFound);
    assert.deepEqual(unknown.body.error.data, { kind: "event" });
    assert.equal((await poll(5 as any, null)).body.error.code, ErrorCode.InvalidParams, "argument type checked");
    assert.equal((await poll("x", "abc")).body.error.code, ErrorCode.InvalidParams, "cursor checked");
  });
});

describe("push", () => {
  test("streams matching events, heartbeats, and replays from a cursor", async () => {
    const live = await openStream(41, { name: CREATED, arguments: { customer: "s-alice" }, cursor: null });
    assert.equal(live.res.headers.get("content-type"), "text/event-stream");
    const active = await live.next("notifications/events/active");
    assert.equal(active.params._meta["io.modelcontextprotocol/subscriptionId"], 41, "active frame routed to the request id");
    assert.equal(active.params.truncated, false);

    await emit(hub.url, secret, "order.created", order("s-bob"));
    const sent = order("s-alice");
    await emit(hub.url, secret, "order.created", sent, "evt_stream");
    const event = await live.next("notifications/events/event");
    assert.deepEqual(event.params.data, sent, "first event is the matching one, filtered event absent");
    assert.equal(event.params.eventId, "evt_stream");
    assert.equal(event.params._meta["io.modelcontextprotocol/subscriptionId"], 41);

    const heartbeat = await live.next("notifications/events/heartbeat");
    assert.ok(Number(heartbeat.params.cursor) >= Number(event.params.cursor), "heartbeat cursor at or past last event");
    live.close();

    const replay = await openStream(42, { name: CREATED, arguments: { customer: "s-alice" }, cursor: active.params.cursor });
    await replay.next("notifications/events/active");
    const replayed = await replay.next("notifications/events/event");
    assert.equal(replayed.params.eventId, "evt_stream", "event replayed from cursor");
    replay.close();
  });

  test("invalid stream request is a JSON error, not a stream", async () => {
    const res = await rpc("events/stream", { name: "shop.nope", arguments: {}, cursor: null });
    assert.equal(res.body.error.code, ErrorCode.NotFound);
  });
});

describe("webhook", () => {
  test("verifies the callback, delivers signed events, and refreshes idempotently", async () => {
    const hook = receiver.hook();
    const { body } = await subscribe(hook, "w-alice");
    const sub = body.result;
    assert.match(sub.id, /^sub_[0-9a-f]{24}$/);
    assert.equal(typeof sub.refreshBefore, "string");
    assert.equal(sub.truncated, false);
    assert.equal(hook.verifications.length, 1, "challenge sent before activation");
    assert.ok(hook.verifications[0].verified, "challenge signed with the client secret");
    assert.match(String(hook.verifications[0].headers["webhook-id"]), /^msg_verification_/);
    assert.equal(hook.verifications[0].headers["x-mcp-subscription-id"], sub.id);

    await emit(hub.url, secret, "order.created", order("w-bob"));
    const sent = order("w-alice");
    await emit(hub.url, secret, "order.created", sent, "evt_hook");
    const delivery = await waitFor(() => hook.deliveries[0], "webhook delivery");
    await sleep(50);
    assert.equal(hook.deliveries.length, 1, "filtered event not delivered");
    assert.ok(delivery.verified, "delivery signature verifies");
    assert.equal(delivery.headers["webhook-id"], "evt_hook");
    assert.equal(delivery.headers["x-mcp-subscription-id"], sub.id);
    assert.deepEqual(delivery.body.data, sent);
    assert.equal(typeof delivery.body.cursor, "string");

    const refresh = (await subscribe(hook, "w-alice", { ttlMs: null })).body.result;
    assert.equal(refresh.id, sub.id, "same key, same id");
    assert.equal(refresh.refreshBefore, null, "no-expiry granted when asked for");
    assert.equal(refresh.deliveryStatus.active, true);
    assert.equal(typeof refresh.deliveryStatus.lastDeliveryAt, "string");
    assert.equal(refresh.deliveryStatus.lastError, null);
    assert.equal(hook.verifications.length, 1, "verification cached per principal and url");
  });

  test("retries failures with the same webhook-id and fresh signatures", async () => {
    const hook = receiver.hook({ statuses: [500, 500] });
    await subscribe(hook, "w-retry");
    await emit(hub.url, secret, "order.created", order("w-retry"), "evt_retry");
    await waitFor(() => hook.deliveries.length === 3, "third attempt");
    assert.deepEqual(hook.deliveries.map((d) => d.headers["webhook-id"]), ["evt_retry", "evt_retry", "evt_retry"]);
    assert.ok(hook.deliveries.every((d) => d.verified), "every attempt signed");
    await sleep(200);
    assert.equal(hook.deliveries.length, 3, "no attempts after success");
  });

  test("410 is not retried", async () => {
    const hook = receiver.hook({ statuses: [410] });
    await subscribe(hook, "w-gone");
    await emit(hub.url, secret, "order.created", order("w-gone"));
    await waitFor(() => hook.deliveries.length === 1, "first attempt");
    await sleep(200);
    assert.equal(hook.deliveries.length, 1, "410 stops retries");
    const status = (await subscribe(hook, "w-gone")).body.result.deliveryStatus;
    assert.equal(status.lastError, "http_4xx", "failure surfaced as a category");
  });

  test("unsubscribe stops delivery and is idempotent", async () => {
    const hook = receiver.hook();
    await subscribe(hook, "w-unsub");
    const params = { name: CREATED, arguments: { customer: "w-unsub" }, delivery: { url: hook.url } };
    assert.deepEqual((await rpc("events/unsubscribe", params)).body.result, { resultType: "complete" });
    assert.deepEqual((await rpc("events/unsubscribe", params)).body.result, { resultType: "complete" }, "second unsubscribe still succeeds");
    await emit(hub.url, secret, "order.created", order("w-unsub"));
    await sleep(150);
    assert.equal(hook.deliveries.length, 0, "nothing delivered after unsubscribe");
  });

  test("subscribe replays from a cursor", async () => {
    const hook = receiver.hook();
    const start = (await rpc("events/poll", { name: CREATED, arguments: { customer: "w-replay" }, cursor: null })).body.result.cursor;
    await emit(hub.url, secret, "order.created", order("w-replay"), "evt_replay");
    await subscribe(hook, "w-replay", { cursor: start });
    const delivery = await waitFor(() => hook.deliveries[0], "replayed delivery");
    assert.equal(delivery.body.eventId, "evt_replay");
  });

  test("failed challenge is -32027 challenge_failed and nothing is delivered", async () => {
    const hook = receiver.hook({ echo: false });
    const { body } = await subscribe(hook, "w-liar");
    assert.equal(body.error.code, ErrorCode.CallbackEndpointError);
    assert.deepEqual(body.error.data, { reason: "challenge_failed" });
    await emit(hub.url, secret, "order.created", order("w-liar"));
    await sleep(100);
    assert.equal(hook.deliveries.length, 0);
  });

  test("rejects non-webhook modes and bad secrets", async () => {
    const hook = receiver.hook();
    const push = await rpc("events/subscribe", { name: CREATED, arguments: {}, delivery: { mode: "push" } });
    assert.equal(push.body.error.code, ErrorCode.Unsupported);
    assert.deepEqual(push.body.error.data, { feature: "deliveryMode", value: "push" });
    const weak = await rpc("events/subscribe", { name: CREATED, arguments: {}, delivery: { mode: "webhook", url: hook.url, secret: "hunter2" } });
    assert.equal(weak.body.error.code, ErrorCode.InvalidParams);
  });

  test("an anonymous principal cannot subscribe", async () => {
    const open = await startHub({ port: 0, db: ":memory:", adminToken: ADMIN, clientTokens: "", allowPrivateCallbacks: true });
    try {
      await registerShop(open.url, ADMIN);
      const hook = receiver.hook();
      const { body } = await rpc("events/subscribe", {
        name: CREATED, arguments: {}, delivery: { mode: "webhook", url: hook.url, secret: hook.secret },
      }, { url: open.url });
      assert.equal(body.error.code, ErrorCode.Forbidden);
      assert.equal(hook.verifications.length, 0, "no challenge sent for anonymous callers");
    } finally {
      await open.close();
    }
  });
});
