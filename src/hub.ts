import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, type AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  canonicalJson, ErrorCode, LEGACY_VERSIONS, MODERN_VERSION, secretKey, signedHeaders, verify,
  type EventDescriptor, type EventOccurrence, type ServiceEventDef, type ServiceRegistration,
} from "./protocol.ts";
import { isObject, validate } from "./schema.ts";
import { openStore, type LoggedEvent, type Subscription } from "./store.ts";

export type HubConfig = {
  port: number;
  host: string;
  db: string;
  adminToken: string;
  clientTokens: string; // "principal:token,principal2:token2"
  allowPrivateCallbacks: boolean;
  retryBaseMs: number;
  heartbeatMs: number;
};

const MAX_BODY = 256 * 1024;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EVENT_NAME = /^[a-z0-9_.-]+$/;
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";
const SUBSCRIPTION_HEADER = "X-MCP-Subscription-Id";
const DELIVERY: EventDescriptor["delivery"] = ["webhook", "push", "poll"];
const SERVER_INFO = { name: "mcp-events-hub", version: "0.1.0" };
const CAPABILITIES = { tools: {}, events: { listChanged: false } };
const INSTRUCTIONS =
  "Aggregates MCP Events from many upstream services. Event names are `<service>.<event>`. " +
  "Subscription arguments are exact-match filters on the payload field of the same name.";
const NEXT_POLL_MS = 2000;
const TTL = { default: 3_600_000, min: 60_000, max: 86_400_000 };
const VERIFIED_FOR_MS = 3_600_000;
const ATTEMPTS = 5;

type FailureReason = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

class RpcError extends Error {
  code: number;
  data: unknown;
  status: number;
  constructor(code: number, message: string, data?: unknown, status = 200) {
    super(message);
    this.code = code;
    this.data = data;
    this.status = status;
  }
}

const invalid = (message: string, data?: unknown) => new RpcError(ErrorCode.InvalidParams, message, data);

// The one filter rule shared by poll, push and webhook.
export function matches(args: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return Object.entries(args).every(([k, v]) => canonicalJson(data[k]) === canonicalJson(v));
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE.addSubnet(net, bits, "ipv6");

function failureReason(err: any): FailureReason {
  if (err?.name === "TimeoutError") return "timeout";
  return /CERT|TLS|SSL/.test(String(err?.cause?.code ?? err?.code ?? "")) ? "tls_error" : "connection_refused";
}

const statusReason = (status: number): FailureReason => (status >= 500 ? "http_5xx" : "http_4xx");

const subscriptionId = (principal: string, url: string, name: string, args: Record<string, unknown>) =>
  `sub_${createHash("sha256").update(canonicalJson([principal, url, name, args])).digest("hex").slice(0, 24)}`;

const isLive = (s: Subscription) => s.active && (s.refreshBefore === null || s.refreshBefore > new Date().toISOString());

function parseCursor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw invalid("cursor must be a cursor issued by this hub");
  return Number(value);
}

function optionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw invalid(`${field} must be a non-negative integer`);
  return value as number;
}

function grantTtl(ttlMs: unknown): string | null {
  if (ttlMs === null) return null;
  if (ttlMs !== undefined && !(typeof ttlMs === "number" && Number.isFinite(ttlMs))) throw invalid("ttlMs must be a number or null");
  const ms = Math.min(Math.max((ttlMs as number | undefined) ?? TTL.default, TTL.min), TTL.max);
  return new Date(Date.now() + ms).toISOString();
}

function registrationErrors(body: unknown): string[] {
  if (!isObject(body)) return ["body must be an object"];
  const errors: string[] = [];
  if (typeof body.name !== "string") errors.push("name must be a string");
  if (body.description !== undefined && typeof body.description !== "string") errors.push("description must be a string");
  if (!Array.isArray(body.events)) return [...errors, "events must be an array"];
  const seen = new Set<string>();
  body.events.forEach((e: unknown, i: number) => {
    const at = `events[${i}]`;
    if (!isObject(e)) return void errors.push(`${at} must be an object`);
    if (typeof e.name !== "string" || !EVENT_NAME.test(e.name)) errors.push(`${at}.name must match ${EVENT_NAME}`);
    else if (seen.has(e.name)) errors.push(`${at}.name duplicates ${e.name}`);
    else seen.add(e.name);
    if (typeof e.description !== "string") errors.push(`${at}.description must be a string`);
    const input = e.inputSchema, payload = e.payloadSchema;
    if (!isObject(input) || input.type !== "object") errors.push(`${at}.inputSchema must be an object schema`);
    if (!isObject(payload) || payload.type !== "object") errors.push(`${at}.payloadSchema must be an object schema`);
    if (!isObject(input) || !isObject(payload)) return;
    const payloadProps = isObject(payload.properties) ? payload.properties : {};
    for (const prop of Object.keys(isObject(input.properties) ? input.properties : {})) {
      if (!Object.hasOwn(payloadProps, prop)) errors.push(`${at}.inputSchema.${prop} has no payloadSchema property to filter on`);
    }
  });
  return errors;
}

function isLocalOrigin(origin: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

const rpcError = (id: unknown, code: number, message: string, data?: unknown) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

const header = (req: IncomingMessage, name: string) => req.headers[name] as string | undefined;

function parseClientTokens(spec: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i < 1 || i === pair.length - 1) throw new Error(`HUB_CLIENT_TOKENS entry "${pair}" is not principal:token`);
    tokens.set(pair.slice(i + 1), pair.slice(0, i));
  }
  return tokens;
}

function envConfig(env = process.env): HubConfig {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    db: env.HUB_DB ?? ".data/hub.db",
    adminToken: env.HUB_ADMIN_TOKEN ?? "",
    clientTokens: env.HUB_CLIENT_TOKENS ?? "",
    allowPrivateCallbacks: env.HUB_ALLOW_PRIVATE_CALLBACKS === "1",
    retryBaseMs: 1000,
    heartbeatMs: 15000,
  };
}

export async function startHub(overrides: Partial<HubConfig> = {}): Promise<{ url: string; close(): Promise<void> }> {
  const config = { ...envConfig(), ...overrides };
  const tokens = parseClientTokens(config.clientTokens);
  const store = openStore(config.db);
  const live = new EventEmitter().setMaxListeners(0);
  const closing = new AbortController();
  const verified = new Map<string, number>(); // canonicalJson([principal, url]) -> expiry ms

  function authenticate(authorization: string | undefined): string | null {
    if (tokens.size === 0) return "anonymous";
    const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
    return (token && tokens.get(token)) || null;
  }

  function isAdmin(authorization: string | undefined): boolean {
    if (!config.adminToken) return false;
    const got = Buffer.from(authorization ?? ""), want = Buffer.from(`Bearer ${config.adminToken}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  function resolveSubscription(params: any): { def: ServiceEventDef; args: Record<string, unknown> } {
    if (!isObject(params) || typeof params.name !== "string") throw invalid("name is required");
    const def = store.catalog().get(params.name);
    if (!def) throw new RpcError(ErrorCode.NotFound, `Unknown event: ${params.name}`, { kind: "event" });
    const args = params.arguments ?? {};
    if (!isObject(args)) throw invalid("arguments must be an object");
    const errors = validate(def.inputSchema, args);
    if (errors.length) throw invalid("arguments do not match inputSchema", { errors });
    return { def, args };
  }

  function replay(name: string, args: Record<string, unknown>, after: number, upTo: number, maxAgeMs?: number, limit = Infinity) {
    const floor = maxAgeMs === undefined ? -Infinity : Date.now() - maxAgeMs;
    const events: LoggedEvent[] = [];
    let truncated = false;
    for (const ev of store.range(name, after, upTo)) {
      if (!matches(args, ev.data)) continue;
      if (Date.parse(ev.timestamp) < floor) truncated = true;
      else if (events.push(ev) >= limit) break;
    }
    return { events, truncated };
  }

  function requirePrincipal(principal: string): string {
    if (principal === "anonymous") throw new RpcError(ErrorCode.Forbidden, "Webhook subscriptions require an authenticated principal");
    return principal;
  }

  function callbackUrl(value: unknown): string {
    let url: URL;
    try {
      url = new URL(value as string);
    } catch {
      throw invalid("delivery.url must be an absolute URL");
    }
    if (url.protocol !== "https:" && !(config.allowPrivateCallbacks && url.protocol === "http:")) {
      throw invalid("delivery.url must use https");
    }
    return value as string;
  }

  // ponytail: the address is validated but not pinned, so DNS rebinding between lookup and connect is
  // still possible. Upgrade: an undici dispatcher with a custom lookup that returns the validated address.
  async function post(url: string, headers: Record<string, string>, body: string): Promise<Response> {
    const target = new URL(url);
    if (!config.allowPrivateCallbacks) {
      const addresses = await lookup(target.hostname.replace(/^\[|\]$/g, ""), { all: true });
      if (addresses.some((a) => PRIVATE.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) {
        throw Object.assign(new Error("callback resolves to a non-public address"), { code: "EBLOCKED" });
      }
    }
    return fetch(target, {
      method: "POST", headers, body, redirect: "error",
      signal: AbortSignal.any([closing.signal, AbortSignal.timeout(10_000)]),
    });
  }

  async function verifyCallback(subId: string, url: string, secret: string): Promise<FailureReason | null> {
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    const headers = { ...signedHeaders(secret, `msg_verification_${randomBytes(12).toString("hex")}`, body), [SUBSCRIPTION_HEADER]: subId };
    try {
      const res = await post(url, headers, body);
      if (!res.ok) {
        await res.body?.cancel();
        return statusReason(res.status);
      }
      const echoed = Buffer.from(String((await res.json().catch(() => null))?.challenge ?? ""));
      const expected = Buffer.from(challenge);
      return echoed.length === expected.length && timingSafeEqual(echoed, expected) ? null : "challenge_failed";
    } catch (err) {
      return failureReason(err);
    }
  }

  // ponytail: the body cursor is the event's own seq, not a true ack watermark, so a client persisting
  // it can skip an earlier event that is still retrying. Upgrade: per-subscription min unacked seq.
  function deliver(subId: string, ev: LoggedEvent) {
    const occurrence: EventOccurrence = { eventId: ev.eventId, name: ev.name, timestamp: ev.timestamp, data: ev.data, cursor: String(ev.seq) };
    const body = JSON.stringify(occurrence);
    if (Buffer.byteLength(body) > MAX_BODY) return;
    (async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(config.retryBaseMs * 2 ** (attempt - 1), undefined, { signal: closing.signal });
        // Re-read each attempt so unsubscribe, expiry and secret rotation apply to pending retries.
        const sub = store.subscription(subId);
        if (!sub || !isLive(sub)) return;
        let error: FailureReason | null = null;
        let retry = true;
        try {
          const res = await post(sub.url, { ...signedHeaders(sub.secret, ev.eventId, body), [SUBSCRIPTION_HEADER]: sub.id }, body);
          await res.body?.cancel();
          if (!res.ok) error = statusReason(res.status);
          retry = res.status !== 410 && res.status !== 413;
        } catch (err) {
          if (closing.signal.aborted) return;
          error = failureReason(err);
        }
        store.recordDelivery(subId, error);
        if (!error || !retry) return;
      }
    })().catch((err) => {
      if (!closing.signal.aborted) console.error("webhook delivery failed", err);
    });
  }

  function publish(ev: LoggedEvent) {
    live.emit("event", ev);
    for (const sub of store.liveSubscriptions(ev.name, new Date().toISOString())) {
      if (matches(sub.arguments, ev.data)) deliver(sub.id, ev);
    }
  }

  function stream(id: unknown, params: any, res: ServerResponse) {
    const { def, args } = resolveSubscription(params);
    const cursor = parseCursor(params.cursor);
    const maxAgeMs = optionalInt(params.maxAgeMs, "maxAgeMs");
    const _meta = { [SUBSCRIPTION_META]: id };
    const frame = (method: string, p: Record<string, unknown>) =>
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method, params: { ...p, _meta } })}\n\n`);

    // Highest seq written. Replay below is synchronous, so live events (always seq > head) arrive after
    // it and the watermark only drops overlap.
    let sent = 0;
    const send = (ev: LoggedEvent) => {
      if (ev.seq <= sent) return;
      sent = ev.seq;
      frame("notifications/events/event", { eventId: ev.eventId, name: ev.name, timestamp: ev.timestamp, data: ev.data, cursor: String(ev.seq) });
    };
    const onEvent = (ev: LoggedEvent) => {
      if (ev.name === def.name && matches(args, ev.data)) send(ev);
    };
    live.on("event", onEvent);
    const head = store.head();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    if (cursor === null) {
      sent = head;
      frame("notifications/events/active", { cursor: String(head), truncated: false });
    } else {
      const { events, truncated } = replay(def.name, args, cursor, head, maxAgeMs);
      frame("notifications/events/active", { cursor: String(cursor), truncated });
      events.forEach(send);
    }
    const heartbeat = setInterval(() => frame("notifications/events/heartbeat", { cursor: String(store.head()) }), config.heartbeatMs);
    res.on("close", () => {
      live.off("event", onEvent);
      clearInterval(heartbeat);
    });
  }

  const methods: Record<string, (params: any, principal: string) => unknown> = {
    initialize: (params) => ({
      protocolVersion: LEGACY_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : LEGACY_VERSIONS[0],
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    }),
    "server/discover": () => ({
      supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
      capabilities: CAPABILITIES,
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      instructions: INSTRUCTIONS,
    }),
    ping: () => ({}),
    "tools/list": () => ({ tools: [] }),
    // ponytail: no nextCursor pagination; add it when the catalog outgrows one response.
    "events/list": () => ({
      events: [...store.catalog().values()].map((e): EventDescriptor => ({
        name: e.name, description: e.description, delivery: DELIVERY, inputSchema: e.inputSchema, payloadSchema: e.payloadSchema,
      })),
    }),

    "events/poll": (params) => {
      const { def, args } = resolveSubscription(params);
      const cursor = parseCursor(params.cursor);
      const maxAgeMs = optionalInt(params.maxAgeMs, "maxAgeMs");
      const maxEvents = Math.min(Math.max(optionalInt(params.maxEvents, "maxEvents") ?? 50, 1), 100);
      const head = store.head();
      if (cursor === null) return { events: [], cursor: String(head), truncated: false, hasMore: false, nextPollMs: NEXT_POLL_MS };
      const { events, truncated } = replay(def.name, args, cursor, head, maxAgeMs, maxEvents + 1);
      const hasMore = events.length > maxEvents;
      const page = events.slice(0, maxEvents);
      return {
        events: page.map(({ eventId, name, timestamp, data }) => ({ eventId, name, timestamp, data })),
        cursor: String(hasMore ? page[page.length - 1].seq : head),
        truncated,
        hasMore,
        nextPollMs: NEXT_POLL_MS,
      };
    },

    "events/subscribe": async (params, principal) => {
      requirePrincipal(principal);
      const { def, args } = resolveSubscription(params);
      const delivery = params.delivery;
      if (!isObject(delivery) || delivery.mode !== "webhook") {
        throw new RpcError(ErrorCode.Unsupported, "events/subscribe only supports webhook delivery", {
          feature: "deliveryMode", value: isObject(delivery) ? delivery.mode : undefined,
        });
      }
      const url = callbackUrl(delivery.url);
      const secret = delivery.secret;
      if (typeof secret !== "string" || !secretKey(secret)) throw invalid("delivery.secret must be whsec_ followed by base64 of 24-64 bytes");
      const cursor = parseCursor(params.cursor);
      const maxAgeMs = optionalInt(params.maxAgeMs, "maxAgeMs");
      const refreshBefore = grantTtl(params.ttlMs);
      const id = subscriptionId(principal, url, def.name, args);

      const verifiedKey = canonicalJson([principal, url]);
      if (!((verified.get(verifiedKey) ?? 0) > Date.now())) {
        const reason = await verifyCallback(id, url, secret);
        if (reason) throw new RpcError(ErrorCode.CallbackEndpointError, "Callback endpoint verification failed", { reason });
        verified.set(verifiedKey, Date.now() + VERIFIED_FOR_MS);
      }

      // No await from here on: head is read in the same tick as the upsert, so every later append
      // reaches this subscription through publish() and every earlier one through replay.
      const existing = store.subscription(id);
      store.upsertSubscription({ id, principal, name: def.name, arguments: args, url, secret, refreshBefore });
      const head = store.head();
      let truncated = false;
      // A live subscription is already delivering; its cursor is at or behind the in-flight position.
      if (cursor !== null && !(existing && isLive(existing))) {
        const replayed = replay(def.name, args, cursor, head, maxAgeMs);
        truncated = replayed.truncated;
        for (const ev of replayed.events) deliver(id, ev);
      }
      return {
        id, refreshBefore, cursor: String(head), truncated,
        ...(existing && { deliveryStatus: { active: existing.active, lastDeliveryAt: existing.lastDeliveryAt, lastError: existing.lastError } }),
      };
    },

    "events/unsubscribe": (params, principal) => {
      requirePrincipal(principal);
      const args = params?.arguments ?? {};
      if (typeof params?.name !== "string" || !isObject(args) || typeof params.delivery?.url !== "string") {
        throw invalid("events/unsubscribe needs name, arguments and delivery.url");
      }
      store.deleteSubscription(subscriptionId(principal, params.delivery.url, params.name, args));
      return {};
    },
  };

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") return json(res, 405, { error: "use POST" }, { allow: "POST" });
    const origin = header(req, "origin");
    if (origin !== undefined && !isLocalOrigin(origin)) return json(res, 403, { error: "origin not allowed" });
    const principal = authenticate(header(req, "authorization"));
    if (!principal) return json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    const raw = await readBody(req);
    if (!raw) return json(res, 413, { error: "request too large" }, { connection: "close" });
    let msg: any;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, rpcError(null, ErrorCode.ParseError, "Parse error"));
    }
    if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return json(res, 400, rpcError(isObject(msg) ? msg.id : null, ErrorCode.InvalidRequest, "Invalid Request"));
    }
    if (msg.id === undefined) return void res.writeHead(202).end();

    const { id, method, params } = msg;
    const requested = isObject(params) && isObject(params._meta) ? params._meta[VERSION_META] : undefined;
    const modern = requested !== undefined;
    try {
      if (modern) {
        if (header(req, "mcp-protocol-version") !== requested) {
          throw new RpcError(ErrorCode.HeaderMismatch, "MCP-Protocol-Version header must equal _meta protocolVersion", undefined, 400);
        }
        if (requested !== MODERN_VERSION) {
          throw new RpcError(ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version",
            { supported: [MODERN_VERSION, ...LEGACY_VERSIONS], requested }, 400);
        }
        // ponytail: Mcp-Method is checked only when sent; make it required once every client sends it.
        const methodHeader = header(req, "mcp-method");
        if (methodHeader !== undefined && methodHeader !== method) {
          throw new RpcError(ErrorCode.HeaderMismatch, "Mcp-Method header must equal method", undefined, 400);
        }
      }
      if (method === "events/stream") return stream(id, params, res);
      if (!Object.hasOwn(methods, method)) {
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`, undefined, modern ? 404 : 200);
      }
      const result = (await methods[method](params, principal)) as Record<string, unknown>;
      json(res, 200, { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result });
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      json(res, err.status, rpcError(id, err.code, err.message, err.data));
    }
  }

  async function registerService(req: IncomingMessage, res: ServerResponse, id: string) {
    if (!isAdmin(header(req, "authorization"))) return json(res, 401, { error: "invalid admin token" });
    if (!SERVICE_ID.test(id)) return json(res, 400, { error: `service id must match ${SERVICE_ID}` });
    const raw = await readBody(req);
    if (!raw) return json(res, 413, { error: "body exceeds 256 KiB" }, { connection: "close" });
    let body: any;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { error: "body is not JSON" });
    }
    const errors = registrationErrors(body);
    if (errors.length) return json(res, 400, { error: errors.join("; ") });
    const registration: ServiceRegistration = {
      name: body.name,
      description: body.description,
      events: body.events.map(({ name, description, inputSchema, payloadSchema }: ServiceEventDef) => ({ name, description, inputSchema, payloadSchema })),
    };
    const secret = store.upsertService(id, registration);
    json(res, 200, { id, secret, events: registration.events.map((e) => `${id}.${e.name}`) });
  }

  async function ingest(req: IncomingMessage, res: ServerResponse, id: string) {
    const service = store.service(id);
    if (!service) return json(res, 404, { error: "unknown service" });
    const raw = await readBody(req);
    if (!raw) return json(res, 413, { error: "body exceeds 256 KiB" }, { connection: "close" });
    const text = raw.toString("utf8");
    const webhookId = header(req, "webhook-id");
    const signed = { id: webhookId, timestamp: header(req, "webhook-timestamp"), signature: header(req, "webhook-signature") };
    if (!verify(service.secret, signed, text)) return json(res, 401, { error: "invalid webhook signature" });
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return json(res, 400, { error: "body is not JSON" });
    }
    if (!isObject(body) || typeof body.name !== "string" || !isObject(body.data)
      || (body.eventId !== undefined && typeof body.eventId !== "string")
      || (body.timestamp !== undefined && (typeof body.timestamp !== "string" || Number.isNaN(Date.parse(body.timestamp))))) {
      return json(res, 400, { error: "body must be { name, data, eventId?, timestamp? }" });
    }
    const def = service.events.find((e) => e.name === body.name);
    if (!def) return json(res, 404, { error: `unknown event ${body.name}` });
    const errors = validate(def.payloadSchema, body.data);
    if (errors.length) return json(res, 400, { error: "data does not match payloadSchema", errors });
    const event = {
      name: `${id}.${def.name}`,
      eventId: body.eventId ?? webhookId!,
      timestamp: body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString(),
      data: body.data,
    };
    const { seq, duplicate } = store.append(event);
    if (duplicate) return json(res, 200, { seq, duplicate: true });
    json(res, 202, { seq });
    publish({ seq, ...event });
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (path === "/mcp") return handleMcp(req, res);
    const m = /^\/services\/([^/]+)(\/events)?$/.exec(path);
    if (m && !m[2] && req.method === "PUT") return registerService(req, res, m[1]);
    if (m && m[2] && req.method === "POST") return ingest(req, res, m[1]);
    json(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(err);
      if (res.headersSent) res.end();
      else json(res, 500, { error: "internal error" });
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${config.host}:${port}`,
    async close() {
      closing.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

if (import.meta.main) {
  const hub = await startHub();
  console.log(`mcp-events-hub listening on ${hub.url} (MCP endpoint ${hub.url}/mcp)`);
  if (!process.env.HUB_ADMIN_TOKEN) console.warn("HUB_ADMIN_TOKEN is unset: service registration is disabled");
}
