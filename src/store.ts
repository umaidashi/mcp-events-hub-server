import { canonicalJson, newSecret, type ServiceEventDef, type ServiceRegistration } from "./protocol.ts";

// The one call both backends share: node:sqlite via a prepared-statement cache (src/node.ts) and a
// Durable Object's ctx.storage.sql (src/worker.ts). Rows come back fully read, so no cursor outlives
// the call.
export type Sql = { exec(query: string, ...params: (string | number | null)[]): any[] };

export type LoggedEvent = {
  seq: number;
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
};

export type Subscription = {
  id: string;
  principal: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  refreshBefore: string | null;
  active: boolean;
  lastDeliveryAt: string | null;
  lastError: string | null;
};

export type Store = ReturnType<typeof openStore>;

// One statement per entry: node:sqlite's prepare() silently drops everything after the first.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, secret TEXT NOT NULL,
    events_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, event_id TEXT NOT NULL,
    timestamp TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE (name, event_id))`,
  "CREATE INDEX IF NOT EXISTS events_by_name ON events (name, seq)",
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, name TEXT NOT NULL, arguments_json TEXT NOT NULL,
    url TEXT NOT NULL, secret TEXT NOT NULL, refresh_before TEXT, active INTEGER NOT NULL DEFAULT 1,
    last_delivery_at TEXT, last_error TEXT)`,
  "CREATE INDEX IF NOT EXISTS subscriptions_by_name ON subscriptions (name)",
];

const RANGE_PAGE = 256;

export function openStore(sql: Sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const one = (query: string, ...params: (string | number | null)[]): any => sql.exec(query, ...params)[0];

  const toEvent = (r: any): LoggedEvent => ({
    seq: r.seq, eventId: r.event_id, name: r.name, timestamp: r.timestamp, data: JSON.parse(r.data_json),
  });
  const toSubscription = (r: any): Subscription => ({
    id: r.id, principal: r.principal, name: r.name, arguments: JSON.parse(r.arguments_json), url: r.url,
    secret: r.secret, refreshBefore: r.refresh_before, active: r.active === 1,
    lastDeliveryAt: r.last_delivery_at, lastError: r.last_error,
  });

  return {
    service(id: string): { secret: string; events: ServiceEventDef[] } | undefined {
      const r = one("SELECT secret, events_json FROM services WHERE id = ?", id);
      return r && { secret: r.secret, events: JSON.parse(r.events_json) };
    },

    // Keyed by the namespaced name clients see: `${serviceId}.${event.name}`.
    catalog(): Map<string, ServiceEventDef> {
      const out = new Map<string, ServiceEventDef>();
      for (const r of sql.exec("SELECT id, events_json FROM services ORDER BY id")) {
        for (const e of JSON.parse(r.events_json) as ServiceEventDef[]) {
          out.set(`${r.id}.${e.name}`, { ...e, name: `${r.id}.${e.name}` });
        }
      }
      return out;
    },

    upsertService(id: string, reg: ServiceRegistration): string {
      return one(`
        INSERT INTO services (id, name, description, secret, events_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
          events_json = excluded.events_json, updated_at = excluded.updated_at
        RETURNING secret`,
      id, reg.name, reg.description ?? null, newSecret(), JSON.stringify(reg.events), new Date().toISOString()).secret;
    },

    append(e: Omit<LoggedEvent, "seq">): { seq: number; duplicate: boolean } {
      const r = one(`
        INSERT INTO events (name, event_id, timestamp, data_json) VALUES (?, ?, ?, ?)
        ON CONFLICT (name, event_id) DO NOTHING RETURNING seq`,
      e.name, e.eventId, e.timestamp, JSON.stringify(e.data));
      if (r) return { seq: r.seq, duplicate: false };
      return { seq: one("SELECT seq FROM events WHERE name = ? AND event_id = ?", e.name, e.eventId).seq, duplicate: true };
    },

    head: (): number => one("SELECT COALESCE(MAX(seq), 0) AS head FROM events").head,

    // Paged so a caller that stops early (poll's maxEvents) never loads the whole backlog.
    *range(name: string, after: number, upTo: number): Generator<LoggedEvent> {
      for (let from = after; ;) {
        const rows = sql.exec(
          "SELECT * FROM events WHERE name = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?", name, from, upTo, RANGE_PAGE);
        for (const r of rows) yield toEvent(r);
        if (rows.length < RANGE_PAGE) return;
        from = rows[rows.length - 1].seq;
      }
    },

    subscription(id: string): Subscription | undefined {
      const r = one("SELECT * FROM subscriptions WHERE id = ?", id);
      return r && toSubscription(r);
    },

    liveSubscriptions: (name: string, now: string): Subscription[] =>
      sql.exec(
        "SELECT * FROM subscriptions WHERE name = ? AND active = 1 AND (refresh_before IS NULL OR refresh_before > ?)", name, now,
      ).map(toSubscription),

    upsertSubscription(s: Pick<Subscription, "id" | "principal" | "name" | "arguments" | "url" | "secret" | "refreshBefore">) {
      sql.exec(`
        INSERT INTO subscriptions (id, principal, name, arguments_json, url, secret, refresh_before, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (id) DO UPDATE SET secret = excluded.secret, refresh_before = excluded.refresh_before, active = 1`,
      s.id, s.principal, s.name, canonicalJson(s.arguments), s.url, s.secret, s.refreshBefore);
    },

    deleteSubscription: (id: string) => void sql.exec("DELETE FROM subscriptions WHERE id = ?", id),

    recordDelivery(id: string, error: string | null) {
      if (error) sql.exec("UPDATE subscriptions SET last_error = ? WHERE id = ?", error, id);
      else sql.exec("UPDATE subscriptions SET last_delivery_at = ?, last_error = NULL WHERE id = ?", new Date().toISOString(), id);
    },
  };
}
