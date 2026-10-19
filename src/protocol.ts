// Wire contract for MCP Events (design sketch: modelcontextprotocol/experimental-ext-triggers-events)
// and the hub's service ingest API. Shared by the hub, the mock service, and the tests.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  default?: unknown;
  format?: string;
};

export type DeliveryMode = "poll" | "push" | "webhook";

// What a service registers. The hub publishes it as `${serviceId}.${name}`.
export type ServiceEventDef = {
  name: string;
  description: string;
  // Every property is an equality filter on the payload field of the same name.
  inputSchema: JsonSchema;
  payloadSchema: JsonSchema;
};

export type ServiceRegistration = {
  name: string;
  description?: string;
  events: ServiceEventDef[];
};

// Body of POST /services/:id/events, signed with the service secret.
export type IngestEvent = {
  name: string; // un-namespaced, as registered
  data: Record<string, unknown>;
  eventId?: string; // upstream id for dedup; hub mints one when absent
  timestamp?: string;
};

// events/list item
export type EventDescriptor = {
  name: string;
  description: string;
  delivery: DeliveryMode[];
  inputSchema: JsonSchema;
  payloadSchema: JsonSchema;
};

export type EventOccurrence = {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string | null;
};

export type WebhookDelivery = { mode: "webhook"; url: string; secret?: string };

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  HeaderMismatch: -32020,
  UnsupportedProtocolVersion: -32022,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  // ChatGPT's doc still uses -32015 from an earlier sketch revision.
  CallbackEndpointError: -32027,
} as const;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Standard Webhooks (https://www.standardwebhooks.com). Secret is `whsec_` + base64 key.
export function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

export function secretKey(secret: string): Buffer | null {
  if (!secret.startsWith("whsec_")) return null;
  const key = Buffer.from(secret.slice(6), "base64");
  return key.length >= 24 && key.length <= 64 ? key : null;
}

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = secretKey(secret);
  if (!key) throw new Error("invalid whsec_ secret");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export function signedHeaders(secret: string, id: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": sign(secret, id, ts, body),
  };
}

export function verify(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  toleranceSec = 300,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, id, ts, body).slice(3), "base64");
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const got = Buffer.from(value, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
