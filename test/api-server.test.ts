import assert from "node:assert/strict";
import { test } from "node:test";
import { startApi } from "../mock/api-server.ts";
import { startHub } from "../src/node.ts";

test("each 5xx the API answers reaches the hub once as api.error.occurred; a 200 sends nothing", async (t) => {
  const hub = await startHub({ port: 0, db: ":memory:", adminToken: "admin" });
  t.after(() => hub.close());
  const api = await startApi({ hubUrl: hub.url, adminToken: "admin", port: 0, host: "127.0.0.1", failureRate: 0, trafficIntervalMs: 0 });
  t.after(() => api.close());

  const hit = async (query: string) => {
    const res = await fetch(`${api.url}/orders/1${query}`);
    await res.body?.cancel();
    return { status: res.status, requestId: res.headers.get("x-request-id") };
  };
  const ok = await hit("");
  const critical = await hit("?fail=critical");
  const warning = await hit("?fail=warning");
  assert.deepEqual([ok.status, critical.status, warning.status], [200, 500, 503]);
  await api.close();

  const res = await fetch(`${hub.url}/admin/api/events?limit=200`, { headers: { authorization: "Bearer admin" } });
  const errors = (await res.json()).events
    .filter((e: any) => e.name === "api.error.occurred")
    .map(({ data: { error_id, message, ...rest } }: any) => (assert.match(error_id, /^err_/), assert.ok(message), rest))
    .sort((a: any, b: any) => a.status - b.status);
  assert.deepEqual(errors, [
    { request_id: critical.requestId, method: "GET", route: "/orders/:id", status: 500, severity: "critical" },
    { request_id: warning.requestId, method: "GET", route: "/orders/:id", status: 503, severity: "warning" },
  ]);
});
