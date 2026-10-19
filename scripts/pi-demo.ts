// End-to-end proof with a real LLM: pi subscribes through the hub and reacts to a filtered event.
// Usage: node scripts/pi-demo.ts   (PI_DEMO_MODEL=anthropic/claude-haiku-4-5 to use the Anthropic login instead)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startHub } from "../src/hub.ts";
import { emit, registerShop } from "../mock/service.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODEL = process.env.PI_DEMO_MODEL ?? "openai-codex/gpt-5.6-luna";
const TIMEOUT_MS = 120_000;
const ADMIN = "demo-admin";
const CLIENT_TOKEN = "demo-client-token";

type Rec = Record<string, any>;
const records: Rec[] = [];
const waiters: { pred: (r: Rec) => boolean; resolve: () => void }[] = [];

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";

function waitFor(what: string, pred: (r: Rec) => boolean): Promise<void> {
  if (records.some(pred)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s waiting for ${what}`)), TIMEOUT_MS);
    waiters.push({ pred, resolve: () => (clearTimeout(t), resolve()) });
  });
}

function onRecord(r: Rec) {
  records.push(r);
  if (r.type === "tool_execution_start") console.log(`[tool] ${r.toolName} ${JSON.stringify(r.args)}`);
  if (r.type === "tool_execution_end") console.log(`[tool ${r.isError ? "error" : "ok"}] ${textOf(r.result?.content).split("\n")[0]}`);
  if (r.type === "message_end" && r.message?.role === "assistant") {
    const t = textOf(r.message.content).trim();
    if (t) console.log(`[assistant] ${t}`);
    if (r.message.errorMessage) console.log(`[assistant error] ${r.message.errorMessage}`);
  }
  if (r.type === "message_end" && r.message?.customType) console.log(`[${r.message.customType}] ${textOf(r.message.content).split("\n")[0]}`);
  if (r.type === "response" && !r.success) console.log(`[rpc error] ${r.command}: ${r.error}`);
  for (const w of [...waiters]) if (w.pred(r)) waiters.splice(waiters.indexOf(w), 1), w.resolve();
}

const hub = await startHub({ port: 0, db: ":memory:", adminToken: ADMIN, clientTokens: `demo:${CLIENT_TOKEN}` });
let pi: ReturnType<typeof spawn> | undefined;
let code = 0;
try {
  const { secret } = await registerShop(hub.url, ADMIN);
  console.log(`hub ${hub.url}, model ${MODEL}`);

  pi = spawn(
    "pi",
    ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--no-approve", "--no-builtin-tools", "--thinking", "off", "--model", MODEL,
      "--extension", "pi/mcp-events.ts"],
    { cwd: ROOT, env: { ...process.env, MCP_EVENTS_HUB_URL: `${hub.url}/mcp`, MCP_EVENTS_HUB_TOKEN: CLIENT_TOKEN }, stdio: ["pipe", "pipe", "pipe"] },
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
  const prompt =
    "MCP events hub のカタログを見て、customer が alice の shop.order.created を購読してください。" +
    "購読の instructions は「reply with one line: ORDER <order_id> <amount> <currency>」にしてください。";
  pi.stdin!.write(JSON.stringify({ id: "p1", type: "prompt", message: prompt }) + "\n");
  await race(waitFor("agent_settled after the subscribe prompt", (r) => r.type === "agent_settled"));

  const subscribed = records.some((r) => r.type === "tool_execution_end" && r.toolName === "events_subscribe" && !r.isError);
  if (!subscribed) throw new Error("the agent did not complete a successful events_subscribe call");

  const settledBefore = settledCount();
  for (const [customer, id, amount] of [["bob", "o-bob-1", 900], ["alice", "o-alice-1", 4200]] as const) {
    const res = await emit(hub.url, secret, "order.created", { order_id: id, customer, amount, currency: "JPY" }, `evt-${id}`);
    console.log(`[emit] ${id} for ${customer} -> HTTP ${res.status}`);
    if (res.status >= 300) throw new Error(`emit ${id} failed: ${JSON.stringify(res.body)}`);
  }

  await race(waitFor("an assistant reply containing ORDER o-alice-1", (r) =>
    r.type === "message_end" && r.message?.role === "assistant" && textOf(r.message.content).includes("ORDER o-alice-1")));
  await race(waitFor("agent_settled after the event turn", (r) => r.type === "agent_settled" && settledCount() > settledBefore));

  if (records.some((r) => JSON.stringify(r).includes("o-bob-1"))) throw new Error("bob's order o-bob-1 reached pi despite the customer=alice filter");
  console.log("PASS: alice's order triggered a turn with the expected reply; bob's order never reached pi");
} catch (err) {
  console.error(`FAIL: ${(err as Error).message}`);
  code = 1;
} finally {
  pi?.stdin?.end();
  pi?.kill();
  await hub.close();
}
process.exit(code);
