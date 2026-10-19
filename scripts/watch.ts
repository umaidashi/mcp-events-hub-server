// Subscribes through the real pi extension without pi or an LLM, and prints every event the hub delivers.
// Usage: node scripts/watch.ts [event name] [arguments JSON]
//   node scripts/watch.ts shop.order.created '{"customer":"alice"}'
// Reads the same MCP_EVENTS_* variables as the extension (hub URL, token, delivery mode, callback host/URL).
import { registerHooks } from "node:module";

const stubs: Record<string, string> = {
  "@earendil-works/pi-ai": "export const Type = new Proxy({}, { get: () => (x) => x });",
  "@earendil-works/pi-coding-agent": "export const defineTool = (t) => t;",
};
registerHooks({
  resolve: (spec, ctx, next) =>
    stubs[spec] ? { url: `data:text/javascript,${encodeURIComponent(stubs[spec])}`, shortCircuit: true } : next(spec, ctx),
});

const name = process.argv[2] ?? "shop.order.created";
const args = JSON.parse(process.argv[3] ?? "{}");
const { default: extension } = await import("../pi/mcp-events.ts");

const tools: Record<string, any> = {};
const handlers: Record<string, () => Promise<void>> = {};
let received = 0;
extension({
  registerTool: (tool: any) => (tools[tool.name] = tool),
  on: (event: string, handler: any) => (handlers[event] = handler),
  sendMessage: (message: any) => {
    if (message.customType === "mcp-event-ended") return console.log(`ended: ${message.content}`);
    const { subscription, event } = message.details;
    received++;
    console.log(`#${received} [${subscription.mode}] ${event.timestamp} ${event.name} ${event.eventId} ${JSON.stringify(event.data)}`);
  },
} as any);

const result = await tools.events_subscribe.execute("watch", { name, arguments: args });
console.log(result.content[0].text);

const stop = async () => {
  await handlers.session_shutdown?.();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
