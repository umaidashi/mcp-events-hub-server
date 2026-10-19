import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, newSecret, type ServiceEventDef, type ServiceRegistration } from "./protocol.ts";

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

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, secret TEXT NOT NULL,
      events_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, event_id TEXT NOT NULL,
      timestamp TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE (name, event_id));
    CREATE INDEX IF NOT EXISTS events_by_name ON events (name, seq);
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, name TEXT NOT NULL, arguments_json TEXT NOT NULL,
      url TEXT NOT NULL, secret TEXT NOT NULL, refresh_before TEXT, active INTEGER NOT NULL DEFAULT 1,
      last_delivery_at TEXT, last_error TEXT);
    CREATE INDEX IF NOT EXISTS subscriptions_by_name ON subscriptions (name);
  `);

  const q = {
    service: db.prepare("SELECT secret, events_json FROM services WHERE id = ?"),
    services: db.prepare("SELECT id, events_json FROM services ORDER BY id"),
    upsertService: db.prepare(`
      INSERT INTO services (id, name, description, secret, events_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
        events_json = excluded.events_json, updated_at = excluded.updated_at
      RETURNING secret`),
    append: db.prepare(`
      INSERT INTO events (name, event_id, timestamp, data_json) VALUES (?, ?, ?, ?)
      ON CONFLICT (name, event_id) DO NOTHING RETURNING seq`),
    existing: db.prepare("SELECT seq FROM events WHERE name = ? AND event_id = ?"),
    head: db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM events"),
    range: db.prepare("SELECT * FROM events WHERE name = ? AND seq > ? AND seq <= ? ORDER BY seq"),
    subscription: db.prepare("SELECT * FROM subscriptions WHERE id = ?"),
    liveSubscriptions: db.prepare(
      "SELECT * FROM subscriptions WHERE name = ? AND active = 1 AND (refresh_before IS NULL OR refresh_before > ?)"),
    upsertSubscription: db.prepare(`
      INSERT INTO subscriptions (id, principal, name, arguments_json, url, secret, refresh_before, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (id) DO UPDATE SET secret = excluded.secret, refresh_before = excluded.refresh_before, active = 1`),
    deleteSubscription: db.prepare("DELETE FROM subscriptions WHERE id = ?"),
    delivered: db.prepare("UPDATE subscriptions SET last_delivery_at = ?, last_error = NULL WHERE id = ?"),
    failed: db.prepare("UPDATE subscriptions SET last_error = ? WHERE id = ?"),
  };

  const toEvent = (r: any): LoggedEvent => ({
    seq: r.seq, eventId: r.event_id, name: r.name, timestamp: r.timestamp, data: JSON.parse(r.data_json),
  });
  const toSubscription = (r: any): Subscription => ({
    id: r.id, principal: r.principal, name: r.name, arguments: JSON.parse(r.arguments_json), url: r.url,
    secret: r.secret, refreshBefore: r.refresh_before, active: r.active === 1,
    lastDeliveryAt: r.last_delivery_at, lastError: r.last_error,
  });

  return {
    close: () => db.close(),

    service(id: string): { secret: string; events: ServiceEventDef[] } | undefined {
      const r: any = q.service.get(id);
      return r && { secret: r.secret, events: JSON.parse(r.events_json) };
    },

    // Keyed by the namespaced name clients see: `${serviceId}.${event.name}`.
    catalog(): Map<string, ServiceEventDef> {
      const out = new Map<string, ServiceEventDef>();
      for (const r of q.services.all() as any[]) {
        for (const e of JSON.parse(r.events_json) as ServiceEventDef[]) {
          out.set(`${r.id}.${e.name}`, { ...e, name: `${r.id}.${e.name}` });
        }
      }
      return out;
    },

    upsertService(id: string, reg: ServiceRegistration): string {
      const r: any = q.upsertService.get(
        id, reg.name, reg.description ?? null, newSecret(), JSON.stringify(reg.events), new Date().toISOString());
      return r.secret;
    },

    append(e: Omit<LoggedEvent, "seq">): { seq: number; duplicate: boolean } {
      const r: any = q.append.get(e.name, e.eventId, e.timestamp, JSON.stringify(e.data));
      if (r) return { seq: r.seq, duplicate: false };
      return { seq: (q.existing.get(e.name, e.eventId) as any).seq, duplicate: true };
    },

    head: (): number => (q.head.get() as any).head,

    *range(name: string, after: number, upTo: number): Generator<LoggedEvent> {
      for (const r of q.range.iterate(name, after, upTo)) yield toEvent(r);
    },

    subscription(id: string): Subscription | undefined {
      const r = q.subscription.get(id);
      return r && toSubscription(r);
    },

    liveSubscriptions: (name: string, now: string): Subscription[] =>
      (q.liveSubscriptions.all(name, now) as any[]).map(toSubscription),

    upsertSubscription(s: Pick<Subscription, "id" | "principal" | "name" | "arguments" | "url" | "secret" | "refreshBefore">) {
      q.upsertSubscription.run(s.id, s.principal, s.name, canonicalJson(s.arguments), s.url, s.secret, s.refreshBefore);
    },

    deleteSubscription: (id: string) => void q.deleteSubscription.run(id),

    recordDelivery(id: string, error: string | null) {
      if (error) q.failed.run(error, id);
      else q.delivered.run(new Date().toISOString(), id);
    },
  };
}
