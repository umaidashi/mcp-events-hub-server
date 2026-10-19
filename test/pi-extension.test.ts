// Drives pi/mcp-events.ts against a real hub without pi or an LLM: the two pi imports are stubbed
// and the tools are called directly.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startHub } from "../src/node.ts";
import { signedHeaders } from "../src/protocol.ts";
import { emit, registerShop } from "../mock/service.ts";

const stubs: Record<string, string> = {
  "@earendil-works/pi-ai": "export const Type = new Proxy({}, { get: () => (x) => x });",
  "@earendil-works/pi-coding-agent": "export const defineTool = (t) => t;",
};
registerHooks({
  resolve: (spec, ctx, next) =>
    stubs[spec] ? { url: `data:text/javascript,${encodeURIComponent(stubs[spec])}`, shortCircuit: true } : next(spec, ctx),
});

let hub: Awaited<ReturnType<typeof startHub>>;
let secret: string;
before(async () => {
  hub = await startHub({ port: 0, db: ":memory:", adminToken: "a", clientTokens: "demo:t", allowPrivateCallbacks: true, retryBaseMs: 50 });
  ({ secret } = await registerShop(hub.url, "a"));
});
after(() => hub.close());

// The extension reads its env at load time, so each mode gets its own module instance.
async function loadExtension(t: TestContext, mode: string, token = "t") {
  process.env.MCP_EVENTS_HUB_URL = `${hub.url}/mcp`;
  process.env.MCP_EVENTS_HUB_TOKEN = token;
  process.env.MCP_EVENTS_DELIVERY = mode;
  const { default: ext } = await import(`../pi/mcp-events.ts?mode=${mode}&token=${encodeURIComponent(token)}`);
  const tools: Record<string, any> = {}, handlers: Record<string, any> = {}, messages: any[] = [];
  ext({ registerTool: (tool: any) => (tools[tool.name] = tool), on: (e: string, h: any) => (handlers[e] = h), sendMessage: (m: any) => messages.push(m) } as any);
  t.after(() => handlers.session_shutdown?.());
  return { tools, events: () => messages.filter((m) => m.customType === "mcp-event") };
}

const order = (order_id: string, customer: string) => ({ order_id, customer, amount: 1, currency: "JPY" });
const filter = { name: "shop.order.created", arguments: { customer: "alice" } };

for (const mode of ["push", "poll", "webhook"]) {
  test(`${mode}: delivers only matching events, once, until unsubscribed`, async (t) => {
    const { tools, events } = await loadExtension(t, mode);
    const sub = await tools.events_subscribe.execute("1", filter);
    assert.match(sub.content[0].text, new RegExp(`via ${mode}`), "subscribed with the requested mode");

    await emit(hub.url, secret, "order.created", order("o-bob", "bob"), `${mode}-bob`);
    await emit(hub.url, secret, "order.created", order("o-alice", "alice"), `${mode}-alice`);
    await emit(hub.url, secret, "order.created", order("o-alice", "alice"), `${mode}-alice`);
    await sleep(2500);
    assert.deepEqual(events().map((m) => m.details.event.data.order_id), ["o-alice"], "only alice; the hub stores a repeated eventId once");
    assert.equal(events()[0].details.subscription.mode, mode);

    await tools.events_unsubscribe.execute("2", filter);
    await emit(hub.url, secret, "order.created", order("o-alice-2", "alice"), `${mode}-alice-2`);
    await sleep(1500);
    assert.equal(events().length, 1, "nothing after unsubscribe");
  });
}

test("webhook receiver rejects forged, stale and unrouted deliveries", async (t) => {
  const { tools } = await loadExtension(t, "webhook");
  const { details } = await tools.events_subscribe.execute("1", filter);
  const body = JSON.stringify({ eventId: "forged", name: filter.name, timestamp: new Date().toISOString(), data: order("o-x", "alice"), cursor: "999" });
  const post = (url: string, headers: Record<string, string>) => fetch(url, { method: "POST", headers, body }).then((r) => r.status);
  const wrong = signedHeaders(`whsec_${Buffer.alloc(32, 1).toString("base64")}`, "forged", body);
  assert.equal(await post(details.callback, { "content-type": "application/json" }), 401, "unsigned");
  assert.equal(await post(details.callback, wrong), 401, "wrong secret");
  assert.equal(await post(details.callback, { ...wrong, "webhook-timestamp": "1" }), 401, "stale timestamp");
  assert.equal(await post(details.callback.replace(/\/\d+$/, "/999"), wrong), 410, "unknown callback path");
});

test("a token that cannot go in a header names the setting instead of a ByteString error", async (t) => {
  const { tools } = await loadExtension(t, "push", "クライアントトークン");
  for (const call of [() => tools.events_catalog.execute("1", {}), () => tools.events_subscribe.execute("2", filter)]) {
    await assert.rejects(call, (err: Error) => {
      assert.match(err.message, /MCP_EVENTS_HUB_TOKEN/);
      assert.doesNotMatch(err.message, /ByteString|クライアント/, "no opaque fetch error and no echo of the token");
      return true;
    });
  }
});
