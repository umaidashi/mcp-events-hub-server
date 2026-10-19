// End-to-end proof with a real LLM: pi subscribes through the hub and reacts to a filtered event,
// once per delivery mode, each with a fresh pi process and a fresh in-process hub, or the hub at
// PI_DEMO_HUB_URL (which must accept http callbacks to 127.0.0.1 for the webhook mode).
// Usage: ANTHROPIC_API_KEY=... node scripts/pi-demo.ts   (PI_DEMO_DELIVERY=push|poll|webhook|all, PI_DEMO_MODEL=<provider>/<model>,
//        PI_DEMO_HUB_URL=http://127.0.0.1:5173 with HUB_ADMIN_TOKEN and HUB_CLIENT_TOKEN matching that hub)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startHub } from "../src/node.ts";
import { emit, registerShop } from "../mock/service.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODEL = process.env.PI_DEMO_MODEL ?? "anthropic/claude-haiku-5-5";
const MODES = ["push", "poll", "webhook"] as const;
const DELIVERY = process.env.PI_DEMO_DELIVERY ?? "all";
const TIMEOUT_MS = 300_000;
const EXTERNAL_HUB = process.env.PI_DEMO_HUB_URL?.replace(/\/$/, "");
const ADMIN = process.env.HUB_ADMIN_TOKEN ?? "dev-admin";
const CLIENT_TOKEN = process.env.HUB_CLIENT_TOKEN ?? "dev-client";
const SUBSCRIBE_ARGS = {
  name: "shop.order.created",
  arguments: { customer: "alice" },
  instructions: "reply with one line: ORDER <order_id> <amount> <currency>",
};
const PROMPT =
  "Use the MCP events tools. First call the tool events_catalog with no arguments. " +
  `Then call the tool events_subscribe with exactly these arguments: ${JSON.stringify(SUBSCRIBE_ARGS)}. ` +
  "After the subscription succeeds, reply with one short line.";

type Rec = Record<string, any>;
type Mode = (typeof MODES)[number];

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";

// An Anthropic model runs on ANTHROPIC_API_KEY from an empty repo-local agent dir, so the claude.ai
// login stored in ~/.pi/agent/auth.json is never used. Any other model uses the user's agent dir.
function agentEnv(): Record<string, string> {
  if (!MODEL.startsWith("anthropic/")) return {};
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`${MODEL} needs ANTHROPIC_API_KEY, or set PI_DEMO_MODEL to another provider`);
    process.exit(1);
  }
  const dir = `${ROOT}.data/pi-agent`;
  mkdirSync(dir, { recursive: true });
  return { PI_CODING_AGENT_DIR: dir };
}

const AGENT_ENV = agentEnv();

async function runMode(mode: Mode): Promise<void> {
  const records: Rec[] = [];
  const waiters: { pred: (r: Rec) => boolean; resolve: () => void }[] = [];
  const log = (line: string) => console.log(`[${mode}] ${line}`);

  function waitFor(what: string, pred: (r: Rec) => boolean): Promise<void> {
    if (records.some(pred)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s waiting for ${what}`)), TIMEOUT_MS);
      waiters.push({ pred, resolve: () => (clearTimeout(t), resolve()) });
    });
  }

  function onRecord(r: Rec) {
    records.push(r);
    if (r.type === "tool_execution_start") log(`[tool] ${r.toolName} ${JSON.stringify(r.args)}`);
    if (r.type === "tool_execution_end") log(`[tool ${r.isError ? "error" : "ok"}] ${textOf(r.result?.content).split("\n")[0]}`);
    if (r.type === "message_end" && r.message?.role === "assistant") {
      const t = textOf(r.message.content).trim();
      if (t) log(`[assistant] ${t}`);
      if (r.message.errorMessage) log(`[assistant error] ${r.message.errorMessage}`);
    }
    if (r.type === "message_end" && r.message?.customType) log(`[${r.message.customType}] ${textOf(r.message.content).split("\n")[0]}`);
    if (r.type === "response" && !r.success) log(`[rpc error] ${r.command}: ${r.error}`);
    for (const w of [...waiters]) if (w.pred(r)) waiters.splice(waiters.indexOf(w), 1), w.resolve();
  }

  const hub = EXTERNAL_HUB
    ? { url: EXTERNAL_HUB, close: async () => {} }
    : await startHub({ port: 0, db: ":memory:", adminToken: ADMIN, clientTokens: `demo:${CLIENT_TOKEN}`, allowPrivateCallbacks: true });
  let pi: ReturnType<typeof spawn> | undefined;
  try {
    const { secret } = await registerShop(hub.url, ADMIN);
    log(`hub ${hub.url}, model ${MODEL}`);

    pi = spawn(
      "pi",
      ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-approve", "--no-builtin-tools", "--thinking", "off", "--model", MODEL,
        "--extension", "pi/mcp-events.ts"],
      {
        cwd: ROOT,
        env: { ...process.env, ...AGENT_ENV, MCP_EVENTS_HUB_URL: `${hub.url}/mcp`, MCP_EVENTS_HUB_TOKEN: CLIENT_TOKEN, MCP_EVENTS_DELIVERY: mode },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<never>((_, reject) => pi!.on("exit", (c) => reject(new Error(`pi exited with code ${c}`))));
    exited.catch(() => {});
    let stderr = "";
    pi.stderr!.on("data", (d) => (stderr += d));
    let buf = "";
    pi.stdout!.on("data", (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) onRecord(JSON.parse(line));
      }
    });
    const race = (p: Promise<void>) => Promise.race([p, exited]).catch((e) => Promise.reject(new Error(`${e.message}\n${stderr.slice(-2000)}`)));

    const settledCount = () => records.filter((r) => r.type === "agent_settled").length;
    pi.stdin!.write(JSON.stringify({ id: "p1", type: "prompt", message: PROMPT }) + "\n");
    await race(waitFor("agent_settled after the subscribe prompt", (r) => r.type === "agent_settled"));

    const subscribed = records.find((r) => r.type === "tool_execution_end" && r.toolName === "events_subscribe" && !r.isError);
    if (!subscribed) throw new Error("the agent did not complete a successful events_subscribe call");
    if (!textOf(subscribed.result?.content).includes(`via ${mode}`)) throw new Error(`events_subscribe did not use ${mode}: ${textOf(subscribed.result?.content)}`);

    const settledBefore = settledCount();
    // No eventId: an external hub keeps its log across modes and runs and would store a repeated one once.
    for (const [customer, id, amount] of [["bob", "o-bob-1", 900], ["alice", "o-alice-1", 4200]] as const) {
      const res = await emit(hub.url, secret, "order.created", { order_id: id, customer, amount, currency: "JPY" });
      log(`[emit] ${id} for ${customer} -> HTTP ${res.status}`);
      if (res.status >= 300) throw new Error(`emit ${id} failed: ${JSON.stringify(res.body)}`);
    }

    await race(waitFor(`the alice event delivered via ${mode}`, (r) =>
      r.type === "message_end" && r.message?.customType === "mcp-event" && r.message.details?.subscription?.mode === mode
      && r.message.details?.event?.data?.order_id === "o-alice-1"));
    await race(waitFor("an assistant reply containing ORDER o-alice-1", (r) =>
      r.type === "message_end" && r.message?.role === "assistant" && textOf(r.message.content).includes("ORDER o-alice-1")));
    await race(waitFor("agent_settled after the event turn", (r) => r.type === "agent_settled" && settledCount() > settledBefore));

    if (records.some((r) => JSON.stringify(r).includes("o-bob-1"))) throw new Error("bob's order o-bob-1 reached pi despite the customer=alice filter");
  } finally {
    pi?.stdin?.end();
    pi?.kill();
    await hub.close();
  }
}

if (DELIVERY !== "all" && !(MODES as readonly string[]).includes(DELIVERY)) {
  console.error(`PI_DEMO_DELIVERY must be push, poll, webhook or all, not ${DELIVERY}`);
  process.exit(1);
}
const results: [Mode, string | null][] = [];
for (const mode of DELIVERY === "all" ? MODES : [DELIVERY as Mode]) {
  const started = Date.now();
  try {
    await runMode(mode);
    results.push([mode, null]);
    console.log(`PASS ${mode} (${Math.round((Date.now() - started) / 1000)}s): alice's order triggered a turn with the expected reply; bob's order never reached pi`);
  } catch (err) {
    results.push([mode, (err as Error).message]);
    console.log(`FAIL ${mode} (${Math.round((Date.now() - started) / 1000)}s): ${(err as Error).message}`);
  }
}
const failed = results.filter(([, err]) => err);
console.log(`summary: ${results.length - failed.length}/${results.length} passed with ${MODEL}${failed.length ? `; failed: ${failed.map(([m]) => m).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
