// The hub as one fetch handler over web-standard Request/Response, so Node (src/node.ts) and a
// Durable Object (src/worker.ts) serve the same code. Platform specifics come in as arguments.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  canonicalJson, ErrorCode, LEGACY_VERSIONS, MODERN_VERSION, secretKey, signedHeaders, verify,
  type EventDescriptor, type EventOccurrence, type ServiceEventDef, type ServiceRegistration,
} from "./protocol.ts";
import { ADMIN_PAGE, ADMIN_PAGE_HEADERS } from "./admin-page.ts";
import { isObject, validate } from "./schema.ts";
import type { LoggedEvent, Store, Subscription } from "./store.ts";

export type HubConfig = {
  adminToken: string;
  clientTokens: string; // "principal:token,principal2:token2"
  allowPrivateCallbacks: boolean;
  retryBaseMs: number;
  heartbeatMs: number;
};

// Throws when a callback URL points somewhere the hub must not POST to. Node resolves DNS; the
// Worker can only inspect the literal host.
export type CallbackGuard = (url: URL) => Promise<void>;

export type Hub = ReturnType<typeof createHub>;

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

// An open events/stream. Push state lives only in this process (the single Durable Object on
// Workers), so this set is the whole picture of who is streaming.
type PushStream = {
  id: unknown; // the JSON-RPC request id, which is also the stream's subscriptionId
  principal: string;
  name: string;
  arguments: Record<string, unknown>;
  connectedAt: string;
  sent: number; // highest seq written to the stream
  onEvent(ev: LoggedEvent): void;
};

type WebhookState = "live" | "expired" | "failing";

const EVENTS_LIMIT = { default: 50, max: 200 };

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

function failureReason(err: any): FailureReason {
  if (err?.name === "TimeoutError") return "timeout";
  return /CERT|TLS|SSL/.test(String(err?.cause?.code ?? err?.code ?? "")) ? "tls_error" : "connection_refused";
}

const statusReason = (status: number): FailureReason => (status >= 500 ? "http_5xx" : "http_4xx");

const subscriptionId = (principal: string, url: string, name: string, args: Record<string, unknown>) =>
  `sub_${createHash("sha256").update(canonicalJson([principal, url, name, args])).digest("hex").slice(0, 24)}`;

const isLive = (s: Subscription) => s.active && (s.refreshBefore === null || s.refreshBefore > new Date().toISOString());

const webhookState = (s: Subscription): WebhookState => (!isLive(s) ? "expired" : s.lastError ? "failing" : "live");

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

// TODO(auth): only localhost Origins pass. Server-to-server clients send no Origin and are unaffected,
// but a browser-based client on any other origin is refused outright; there is no allow-list.
function isLocalOrigin(origin: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// null when the body exceeds MAX_BODY; reading stops there.
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const decoder = new TextDecoder();
  let text = "", size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY) return null;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

const rpcError = (id: unknown, code: number, message: string, data?: unknown) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

function parseClientTokens(spec: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i < 1 || i === pair.length - 1) throw new Error(`HUB_CLIENT_TOKENS entry "${pair}" is not principal:token`);
    tokens.set(pair.slice(i + 1), pair.slice(0, i));
  }
  return tokens;
}

// Both entries read the same names: process.env on Node, the Worker's env bindings on Cloudflare.
export function envConfig(env: { HUB_ADMIN_TOKEN?: string; HUB_CLIENT_TOKENS?: string; HUB_ALLOW_PRIVATE_CALLBACKS?: string }): HubConfig {
  return {
    adminToken: env.HUB_ADMIN_TOKEN ?? "",
    clientTokens: env.HUB_CLIENT_TOKENS ?? "",
    allowPrivateCallbacks: env.HUB_ALLOW_PRIVATE_CALLBACKS === "1",
    retryBaseMs: 1000,
    heartbeatMs: 15000,
  };
}

export function createHub(store: Store, config: HubConfig, guardCallback: CallbackGuard) {
  const tokens = parseClientTokens(config.clientTokens);
  const live = new Set<PushStream>();
  const closing = new AbortController();
  // TODO(auth): a passed challenge is cached per (principal, url) for an hour, so re-subscribing with a
  // different secret or event skips the challenge. The cache is process (Durable Object) memory only.
  const verified = new Map<string, number>(); // canonicalJson([principal, url]) -> expiry ms

  // TODO(auth): a static bearer-token map. There is no OAuth 2.1 or protected resource metadata, which the
  // MCP authorization spec expects of remote servers and ChatGPT-style clients need. With no tokens
  // configured everyone is "anonymous", and poll and push are open to anyone who can reach the hub.
  function authenticate(authorization: string | null): string | null {
    if (tokens.size === 0) return "anonymous";
    const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
    return (token && tokens.get(token)) || null;
  }

  // TODO(auth): one shared HUB_ADMIN_TOKEN can register, and overwrite, any service id. There is no
  // per-service owner credential.
  function isAdmin(authorization: string | null): boolean {
    if (!config.adminToken) return false;
    const got = Buffer.from(authorization ?? ""), want = Buffer.from(`Bearer ${config.adminToken}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  // TODO(auth): any authenticated principal can list, poll, stream and subscribe to every service's
  // events. There is no per-principal ACL on services or event names.
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

  // redirect "manual" rather than "error": Workers reject "error", and a 3xx is not ok, so it fails the
  // same way on both platforms.
  async function post(url: string, headers: Record<string, string>, body: string): Promise<Response> {
    const target = new URL(url);
    if (!config.allowPrivateCallbacks) await guardCallback(target);
    return fetch(target, {
      method: "POST", headers, body, redirect: "manual",
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
      const echoed = Buffer.from(String((await res.json().catch(() => null) as any)?.challenge ?? ""));
      const expected = Buffer.from(challenge);
      return echoed.length === expected.length && timingSafeEqual(echoed, expected) ? null : "challenge_failed";
    } catch (err) {
      return failureReason(err);
    }
  }

  // ponytail: the body cursor is the event's own seq, not a true ack watermark, so a client persisting
  // it can skip an earlier event that is still retrying. Upgrade: per-subscription min unacked seq.
  // ponytail: retries wait on in-memory timers. A Durable Object evicted mid-backoff drops the remaining
  // attempts. Upgrade: a pending_deliveries table drained by a Durable Object alarm.
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
    for (const push of live) push.onEvent(ev);
    for (const sub of store.liveSubscriptions(ev.name, new Date().toISOString())) {
      if (matches(sub.arguments, ev.data)) deliver(sub.id, ev);
    }
  }

  // Ends when request.signal aborts (the client left; Workers need enable_request_signal) or the body is
  // cancelled.
  function stream(id: unknown, params: any, principal: string, signal: AbortSignal): Response {
    const { def, args } = resolveSubscription(params);
    const cursor = parseCursor(params.cursor);
    const maxAgeMs = optionalInt(params.maxAgeMs, "maxAgeMs");
    const _meta = { [SUBSCRIPTION_META]: id };
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c), cancel: () => end() });
    const frame = (method: string, p: Record<string, unknown>) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", method, params: { ...p, _meta } })}\n\n`));

    // push.sent is the watermark. Replay below is synchronous, so live events (always seq > head)
    // arrive after it and the watermark only drops overlap.
    const send = (ev: LoggedEvent) => {
      if (ev.seq <= push.sent) return;
      push.sent = ev.seq;
      frame("notifications/events/event", { eventId: ev.eventId, name: ev.name, timestamp: ev.timestamp, data: ev.data, cursor: String(ev.seq) });
    };
    const push: PushStream = {
      id, principal, name: def.name, arguments: args, connectedAt: new Date().toISOString(), sent: 0,
      onEvent: (ev) => {
        if (ev.name === def.name && matches(args, ev.data)) send(ev);
      },
    };
    live.add(push);
    const head = store.head();
    if (cursor === null) {
      push.sent = head;
      frame("notifications/events/active", { cursor: String(head), truncated: false });
    } else {
      const { events, truncated } = replay(def.name, args, cursor, head, maxAgeMs);
      frame("notifications/events/active", { cursor: String(cursor), truncated });
      events.forEach(send);
    }
    const heartbeat = setInterval(() => frame("notifications/events/heartbeat", { cursor: String(store.head()) }), config.heartbeatMs);
    const done = AbortSignal.any([signal, closing.signal]);
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      live.delete(push);
      clearInterval(heartbeat);
      done.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      end();
      controller.close();
    };
    if (done.aborted) onAbort();
    else done.addEventListener("abort", onAbort);
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
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

  async function handleMcp(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "use POST" }, { allow: "POST" });
    const origin = request.headers.get("origin");
    if (origin !== null && !isLocalOrigin(origin)) return json(403, { error: "origin not allowed" });
    const principal = authenticate(request.headers.get("authorization"));
    if (!principal) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    const raw = await readBody(request);
    if (raw === null) return json(413, { error: "request too large" }, { connection: "close" });
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return json(400, rpcError(null, ErrorCode.ParseError, "Parse error"));
    }
    if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return json(400, rpcError(isObject(msg) ? msg.id : null, ErrorCode.InvalidRequest, "Invalid Request"));
    }
    if (msg.id === undefined) return new Response(null, { status: 202 });

    const { id, method, params } = msg;
    const requested = isObject(params) && isObject(params._meta) ? params._meta[VERSION_META] : undefined;
    const modern = requested !== undefined;
    try {
      if (modern) {
        if (request.headers.get("mcp-protocol-version") !== requested) {
          throw new RpcError(ErrorCode.HeaderMismatch, "MCP-Protocol-Version header must equal _meta protocolVersion", undefined, 400);
        }
        if (requested !== MODERN_VERSION) {
          throw new RpcError(ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version",
            { supported: [MODERN_VERSION, ...LEGACY_VERSIONS], requested }, 400);
        }
        // ponytail: Mcp-Method is checked only when sent; make it required once every client sends it.
        const methodHeader = request.headers.get("mcp-method");
        if (methodHeader !== null && methodHeader !== method) {
          throw new RpcError(ErrorCode.HeaderMismatch, "Mcp-Method header must equal method", undefined, 400);
        }
      }
      if (method === "events/stream") return stream(id, params, principal, request.signal);
      if (!Object.hasOwn(methods, method)) {
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`, undefined, modern ? 404 : 200);
      }
      const result = (await methods[method](params, principal)) as Record<string, unknown>;
      return json(200, { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result });
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      return json(err.status, rpcError(id, err.code, err.message, err.data));
    }
  }

  async function registerService(request: Request, id: string): Promise<Response> {
    if (!isAdmin(request.headers.get("authorization"))) return json(401, { error: "invalid admin token" });
    if (!SERVICE_ID.test(id)) return json(400, { error: `service id must match ${SERVICE_ID}` });
    const raw = await readBody(request);
    if (raw === null) return json(413, { error: "body exceeds 256 KiB" }, { connection: "close" });
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "body is not JSON" });
    }
    const errors = registrationErrors(body);
    if (errors.length) return json(400, { error: errors.join("; ") });
    const registration: ServiceRegistration = {
      name: body.name,
      description: body.description,
      events: body.events.map(({ name, description, inputSchema, payloadSchema }: ServiceEventDef) => ({ name, description, inputSchema, payloadSchema })),
    };
    // TODO(auth): the ingest secret is minted once and never rotated, and every registration call returns
    // it in the response body, so anyone holding the admin token can read any service's secret.
    const secret = store.upsertService(id, registration);
    return json(200, { id, secret, events: registration.events.map((e) => `${id}.${e.name}`) });
  }

  async function ingest(request: Request, id: string): Promise<Response> {
    const service = store.service(id);
    if (!service) return json(404, { error: "unknown service" });
    const text = await readBody(request);
    if (text === null) return json(413, { error: "body exceeds 256 KiB" }, { connection: "close" });
    const webhookId = request.headers.get("webhook-id");
    const signed = { id: webhookId, timestamp: request.headers.get("webhook-timestamp"), signature: request.headers.get("webhook-signature") };
    if (!verify(service.secret, signed, text)) return json(401, { error: "invalid webhook signature" });
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "body is not JSON" });
    }
    if (!isObject(body) || typeof body.name !== "string" || !isObject(body.data)
      || (body.eventId !== undefined && typeof body.eventId !== "string")
      || (body.timestamp !== undefined && (typeof body.timestamp !== "string" || Number.isNaN(Date.parse(body.timestamp))))) {
      return json(400, { error: "body must be { name, data, eventId?, timestamp? }" });
    }
    const def = service.events.find((e) => e.name === body.name);
    if (!def) return json(404, { error: `unknown event ${body.name}` });
    const errors = validate(def.payloadSchema, body.data);
    if (errors.length) return json(400, { error: "data does not match payloadSchema", errors });
    const event = {
      name: `${id}.${def.name}`,
      eventId: body.eventId ?? webhookId!,
      timestamp: body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString(),
      data: body.data,
    };
    const { seq, duplicate } = store.append(event);
    if (duplicate) return json(200, { seq, duplicate: true });
    publish({ seq, ...event });
    return json(202, { seq });
  }

  // Read models for the admin screen (GET /admin). Secrets never leave through these.
  // ponytail: every list is unpaginated and the overview counts by scanning subscriptions. Add LIMIT and a
  // cursor when services or subscriptions outgrow one response.
  const adminViews: Record<string, (url: URL) => unknown> = {
    overview: () => {
      const services = store.services();
      const webhooks: Record<WebhookState, number> = { live: 0, failing: 0, expired: 0 };
      for (const s of store.subscriptions()) webhooks[webhookState(s)]++;
      return {
        services: services.length,
        eventTypes: services.reduce((n, s) => n + s.events.length, 0),
        webhooks,
        pushStreams: live.size,
        events: store.eventCount(),
      };
    },
    services: () => ({ services: store.services() }),
    subscriptions: () => ({
      webhooks: store.subscriptions().map((s) => ({
        id: s.id, state: webhookState(s), principal: s.principal, name: s.name, arguments: s.arguments, url: s.url,
        refreshBefore: s.refreshBefore, active: s.active, lastDeliveryAt: s.lastDeliveryAt, lastError: s.lastError,
      })),
      push: [...live].map((p) => ({
        id: p.id, principal: p.principal, name: p.name, arguments: p.arguments, connectedAt: p.connectedAt, cursor: String(p.sent),
      })),
    }),
    events: (url) => {
      const asked = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, EVENTS_LIMIT.max) : EVENTS_LIMIT.default;
      return { events: store.recentEvents(limit) };
    },
  };

  // TODO(auth): the whole admin surface (these views and PUT /services/:id) shares one HUB_ADMIN_TOKEN.
  // There are no per-operator accounts or roles, and no audit log of who read or registered what.
  function adminApi(request: Request, url: URL, view: string): Response {
    if (!isAdmin(request.headers.get("authorization"))) return json(401, { error: "invalid admin token" });
    return json(200, adminViews[view](url), { "cache-control": "no-store" });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/mcp") return handleMcp(request);
    if (path === "/admin" && request.method === "GET") return new Response(ADMIN_PAGE, { headers: ADMIN_PAGE_HEADERS });
    const view = /^\/admin\/api\/([a-z]+)$/.exec(path)?.[1];
    if (view && request.method === "GET" && Object.hasOwn(adminViews, view)) return adminApi(request, url, view);
    const m = /^\/services\/([^/]+)(\/events)?$/.exec(path);
    if (m && !m[2] && request.method === "PUT") return registerService(request, m[1]);
    if (m && m[2] && request.method === "POST") return ingest(request, m[1]);
    return json(404, { error: "not found" });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await route(request);
      } catch (err) {
        console.error(err);
        return json(500, { error: "internal error" });
      }
    },
    // Ends open streams and pending webhook retries. The caller owns and closes the store.
    close: () => closing.abort(),
  };
}
