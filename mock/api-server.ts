// A small HTTP API that reports every 5xx it answers to the hub as api.error.occurred.
// Usage: node mock/api-server.ts   (HUB_URL, HUB_ADMIN_TOKEN, PORT, HOST, API_FAILURE_RATE, API_TRAFFIC_INTERVAL_SEC)
//   curl 'http://127.0.0.1:8788/orders/42?fail=critical'
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceRegistration } from "../src/protocol.ts";
import { emit, registerService } from "./service.ts";

type Severity = "warning" | "critical";

const FAILURES: Record<Severity, { status: number; message: string }> = {
  critical: { status: 500, message: "database connection timed out" },
  warning: { status: 503, message: "payment provider responded slowly" },
};
const SEVERITIES = Object.keys(FAILURES) as Severity[];

class Failure extends Error {
  severity: Severity;
  constructor(severity: Severity) {
    super(FAILURES[severity].message);
    this.severity = severity;
  }
}

export const api: ServiceRegistration = {
  name: "API",
  description: "A small HTTP API that reports every 5xx response it sends.",
  events: [{
    name: "error.occurred",
    description: "The API answered a request with a 5xx status.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: SEVERITIES, description: "Only errors of this severity." },
        route: { type: "string", description: "Only errors on this route template, e.g. /orders/:id." },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        error_id: { type: "string" },
        request_id: { type: "string", description: "Also returned to the caller in x-request-id." },
        method: { type: "string" },
        route: { type: "string", description: "Route template, not the raw path." },
        status: { type: "integer" },
        severity: { type: "string", enum: SEVERITIES },
        message: { type: "string" },
      },
      required: ["error_id", "request_id", "method", "route", "status", "severity", "message"],
      additionalProperties: false,
    },
  }],
};

export type ApiConfig = {
  hubUrl: string; adminToken: string; port: number; host: string;
  failureRate: number; // share of /orders/:id requests that fail on their own, 0 to 1
  trafficIntervalMs: number; // 0 disables the built-in traffic loop
};

export async function startApi(config: ApiConfig) {
  const { secret, events } = await registerService(config.hubUrl, config.adminToken, "api", api);

  const routes = [
    { method: "GET", route: "/health", pattern: /^\/health$/, handle: () => ({ ok: true }) },
    {
      method: "GET", route: "/orders/:id", pattern: /^\/orders\/([^/]+)$/,
      handle: ([id]: string[], query: URLSearchParams) => {
        const fail = query.get("fail") ?? (Math.random() < config.failureRate ? SEVERITIES[randomInt(SEVERITIES.length)] : null);
        if (fail && Object.hasOwn(FAILURES, fail)) throw new Failure(fail as Severity);
        return { order_id: id, state: "paid" };
      },
    },
  ];

  const pending = new Set<Promise<void>>();
  function report(data: Record<string, unknown>) {
    const sent: Promise<void> = emit(config.hubUrl, secret, "error.occurred", data, String(data.error_id), "api").then(
      ({ status, body }) => console.log(`emit error.occurred ${JSON.stringify(data)} -> HTTP ${status} ${JSON.stringify(body)}`),
      (err) => console.error(`emit error.occurred ${data.error_id} failed: ${err.message}`),
    ).finally(() => pending.delete(sent));
    pending.add(sent);
  }

  const server = createServer((req, res) => {
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    const url = new URL(req.url ?? "/", "http://api");
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    let status = 200, body: Record<string, unknown>, error: Record<string, unknown> | undefined;
    if (!route) {
      status = 404;
      body = { error: "not found" };
    } else {
      try {
        body = route.handle(route.pattern.exec(url.pathname)!.slice(1), url.searchParams);
      } catch (err) {
        // The one place a failure becomes a response and an event. Anything unexpected is a critical 500.
        const failure = err instanceof Failure
          ? { severity: err.severity, ...FAILURES[err.severity] }
          : { severity: "critical", status: 500, message: String((err as Error)?.message ?? err) };
        status = failure.status;
        body = { error: failure.message };
        error = { error_id: `err_${randomUUID().slice(0, 8)}`, request_id: requestId, method: req.method, route: route.route, ...failure };
      }
    }
    res.writeHead(status, { "content-type": "application/json", "x-request-id": requestId });
    res.end(JSON.stringify({ request_id: requestId, ...body }));
    console.log(`${req.method} ${req.url} -> ${status} ${requestId}`);
    // After the response, so a slow or down hub never delays or breaks the API.
    if (error) report(error);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(config.port, config.host, resolve));
  const url = `http://${config.host}:${(server.address() as AddressInfo).port}`;

  const traffic = config.trafficIntervalMs > 0 && setInterval(() => {
    fetch(`${url}/orders/${randomInt(1, 1000)}`).then((r) => r.body?.cancel(), () => {});
  }, config.trafficIntervalMs);

  return {
    url,
    events,
    // Stops serving, then waits for error reports already on their way to the hub.
    async close() {
      if (traffic) clearInterval(traffic);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.all(pending);
    },
  };
}

if (import.meta.main) {
  const env = process.env;
  const failureRate = Number(env.API_FAILURE_RATE ?? 0);
  const trafficSec = Number(env.API_TRAFFIC_INTERVAL_SEC ?? 0);
  if (!(failureRate >= 0 && failureRate <= 1)) throw new Error(`API_FAILURE_RATE must be between 0 and 1, not ${env.API_FAILURE_RATE}`);
  if (!(trafficSec >= 0)) throw new Error(`API_TRAFFIC_INTERVAL_SEC must be a number of seconds, not ${env.API_TRAFFIC_INTERVAL_SEC}`);
  const server = await startApi({
    hubUrl: env.HUB_URL ?? "http://127.0.0.1:8787",
    adminToken: env.HUB_ADMIN_TOKEN ?? "dev-admin",
    port: Number(env.PORT ?? 8788),
    host: env.HOST ?? "127.0.0.1",
    failureRate,
    trafficIntervalMs: trafficSec * 1000,
  });
  console.log(`api listening on ${server.url}; registered ${server.events.join(", ")}; failure rate ${failureRate}, traffic every ${trafficSec || "-"}s`);
  process.on("SIGTERM", () => server.close().then(() => process.exit(0)));
}
