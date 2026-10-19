import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { signedHeaders, type ServiceRegistration } from "../src/protocol.ts";

const SECRET_FILE = ".data/shop.secret";

const customerFilter = {
  type: "object",
  properties: { customer: { type: "string", description: "Only events for this customer." } },
  additionalProperties: false,
};

export const shop: ServiceRegistration = {
  name: "Shop",
  description: "A fake storefront that emits order lifecycle events.",
  events: [
    {
      name: "order.created",
      description: "A customer placed an order.",
      inputSchema: customerFilter,
      payloadSchema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          customer: { type: "string" },
          amount: { type: "integer", description: "Minor currency units." },
          currency: { type: "string" },
        },
        required: ["order_id", "customer", "amount", "currency"],
        additionalProperties: false,
      },
    },
    {
      name: "order.shipped",
      description: "An order left the warehouse.",
      inputSchema: customerFilter,
      payloadSchema: {
        type: "object",
        properties: { order_id: { type: "string" }, customer: { type: "string" }, carrier: { type: "string" } },
        required: ["order_id", "customer", "carrier"],
        additionalProperties: false,
      },
    },
  ],
};

export async function registerService(
  hubUrl: string, adminToken: string, id: string, registration: ServiceRegistration,
): Promise<{ secret: string; events: string[] }> {
  const res = await fetch(`${hubUrl}/services/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`registration failed (${res.status}): ${JSON.stringify(body)}`);
  return { secret: body.secret, events: body.events };
}

export const registerShop = (hubUrl: string, adminToken: string) => registerService(hubUrl, adminToken, "shop", shop);

export async function emit(
  hubUrl: string, secret: string, name: string, data: Record<string, unknown>, eventId?: string, serviceId = "shop",
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify({ name, data, eventId });
  const res = await fetch(`${hubUrl}/services/${serviceId}/events`, {
    method: "POST",
    headers: signedHeaders(secret, eventId ?? `msg_${randomUUID()}`, body),
    body,
  });
  return { status: res.status, body: await res.json() };
}

if (import.meta.main) {
  const hubUrl = process.env.HUB_URL ?? "http://127.0.0.1:8787";
  const adminToken = process.env.HUB_ADMIN_TOKEN ?? "dev-admin";
  const [command, ...args] = process.argv.slice(2);
  const secret = () => readFileSync(SECRET_FILE, "utf8").trim();

  if (command === "register") {
    const { secret, events } = await registerShop(hubUrl, adminToken);
    mkdirSync(".data", { recursive: true });
    writeFileSync(SECRET_FILE, secret);
    console.log(`registered ${events.join(", ")}; secret saved to ${SECRET_FILE}`);
  } else if (command === "emit" && args[0]) {
    console.log(await emit(hubUrl, secret(), args[0], JSON.parse(args[1] ?? "{}")));
  } else if (command === "loop") {
    const intervalMs = Number(args[0] ?? 5) * 1000;
    for (;;) {
      const data = {
        order_id: `ord_${randomUUID().slice(0, 8)}`,
        customer: ["alice", "bob"][randomInt(2)],
        amount: randomInt(100, 100_000),
        currency: "JPY",
      };
      const { status, body } = await emit(hubUrl, secret(), "order.created", data);
      console.log(`emit order.created ${JSON.stringify(data)} -> HTTP ${status} ${JSON.stringify(body)}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } else {
    console.error("usage: node mock/service.ts register | emit <name> '<json>' | loop [intervalSec]");
    process.exitCode = 1;
  }
}
