// Node entry: node:sqlite storage, a DNS-resolving callback guard, and node:http serving the hub's
// fetch handler.
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHub, envConfig, type Hub, type HubConfig } from "./hub.ts";
import { isPrivateAddress } from "./private-net.ts";
import { openStore, type Sql } from "./store.ts";

export type NodeHubConfig = HubConfig & { port: number; host: string; db: string };

function openSqlite(path: string): { sql: Sql; close(): void } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const statements = new Map<string, StatementSync>();
  return {
    sql: {
      exec(query, ...params) {
        let statement = statements.get(query);
        if (!statement) statements.set(query, (statement = db.prepare(query)));
        return statement.all(...params);
      },
    },
    close: () => db.close(),
  };
}

// ponytail: the address is validated but not pinned, so DNS rebinding between lookup and connect is
// still possible. Upgrade: an undici dispatcher with a custom lookup that returns the validated address.
async function guardCallback(url: URL): Promise<void> {
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error("callback resolves to a non-public address");
}

async function serve(hub: Hub, req: IncomingMessage, res: ServerResponse) {
  const disconnected = new AbortController();
  res.on("close", () => disconnected.abort());
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers,
    signal: disconnected.signal,
    ...(req.method !== "GET" && req.method !== "HEAD" && { body: Readable.toWeb(req) as ReadableStream, duplex: "half" }),
  } as RequestInit);
  const response = await hub.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  await pipeline(Readable.fromWeb(response.body as any), res);
}

export async function startHub(overrides: Partial<NodeHubConfig> = {}): Promise<{ url: string; close(): Promise<void> }> {
  const config: NodeHubConfig = {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "127.0.0.1",
    db: process.env.HUB_DB ?? ".data/hub.db",
    ...envConfig(process.env),
    ...overrides,
  };
  const sqlite = openSqlite(config.db);
  const hub = createHub(openStore(sqlite.sql), config, guardCallback);
  const server = createServer((req, res) => {
    serve(hub, req, res).catch((err) => {
      // A client that hangs up mid-stream fails the pipeline; there is nothing left to answer.
      if (res.headersSent) return void res.destroy();
      console.error(err);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${config.host}:${port}`,
    async close() {
      hub.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      sqlite.close();
    },
  };
}

if (import.meta.main) {
  const hub = await startHub();
  console.log(`mcp-events-hub listening on ${hub.url} (MCP endpoint ${hub.url}/mcp)`);
  if (!process.env.HUB_ADMIN_TOKEN) console.warn("HUB_ADMIN_TOKEN is unset: service registration is disabled");
}
