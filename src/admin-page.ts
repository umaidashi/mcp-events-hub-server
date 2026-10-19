// GET /admin. A static page with no hub data inside: the script reads /admin/api/* with the admin token
// and renders through DOM APIs only. Kept as a string module so the Worker bundle carries it without fs.
import { createHash } from "node:crypto";

const DARK = `--paper: #0e1419; --surface: #151d24; --sunk: #1b252e; --ink: #e4eaf0; --muted: #94a3b1; --rule: #2a3743;
  --hub: #63b7b4; --hub-soft: #173032; --svc: #a6b58c; --push: #84a8f2; --poll: #e2a64c; --webhook: #e47fb1;
  --ok: #6cc591; --ng: #ef857b; color-scheme: dark;`;

const STYLE = `
:root {
  --paper: #f3f5f7; --surface: #ffffff; --sunk: #e8ecf0; --ink: #15202b; --muted: #566472; --rule: #d3dae1;
  --hub: #0f5257; --hub-soft: #dcebea; --svc: #5a6748; --push: #2655b8; --poll: #9a5c00; --webhook: #a3336b;
  --ok: #2f7d4f; --ng: #b3392f; color-scheme: light;
  --serif: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", serif;
  --sans: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", system-ui, sans-serif;
  --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
:root[data-theme="dark"] { ${DARK} }

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.7 var(--sans); }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--hub); outline-offset: 2px; }
code, .mono { font-family: var(--mono); font-size: .88em; }
h1, h2 { font-family: var(--serif); font-weight: 600; margin: 0; text-wrap: balance; }
h1 { font-size: 22px; line-height: 1.3; }
h2 { font-size: 18px; line-height: 1.4; display: flex; align-items: center; gap: 8px; }
p { margin: 0; max-width: 70ch; }
.muted { color: var(--muted); }

.bar { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--rule); background: var(--surface); }
.brand { display: grid; }
.eyebrow { font: 12px/1.4 var(--mono); letter-spacing: .06em; color: var(--hub); }
.actions { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.status { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.status.bad { color: var(--ng); }
.btn { font: 13px var(--sans); color: var(--ink); background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 6px 12px; min-height: 34px; cursor: pointer; }
.btn:hover { border-color: var(--muted); }
.btn.primary { background: var(--hub); border-color: var(--hub); color: var(--surface); font-weight: 600; justify-self: start; }
.btn:disabled { opacity: .5; cursor: progress; }
.toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; cursor: pointer; }
.toggle input { accent-color: var(--hub); width: 16px; height: 16px; margin: 0; }

main { max-width: 1180px; margin: 0 auto; padding: 24px 20px 80px; display: grid; gap: 24px; }
main.gate { max-width: 460px; padding-top: 10vh; }
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 20px; display: grid; gap: 14px; }
.field { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input, textarea { font: 14px var(--sans); color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-radius: 6px; padding: 8px 10px; width: 100%; min-width: 0; }
textarea, .copyrow input { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
textarea { resize: vertical; }
.error { color: var(--ng); font-size: 14px; background: color-mix(in srgb, var(--ng) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--ng) 40%, var(--rule)); border-radius: 6px; padding: 10px 12px; margin: 0; display: grid; gap: 6px; }
.error ul { margin: 0; padding-left: 1.2em; font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }

.rollup { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; }
.tile { box-shadow: 1px 0 0 var(--rule), 0 1px 0 var(--rule); padding: 14px 16px; display: grid; gap: 6px; align-content: start; }
.tile .k { font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.tile .v { font: 600 28px/1.1 var(--mono); font-variant-numeric: tabular-nums; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.6; border-radius: 999px; padding: 0 9px; border: 1px solid; white-space: nowrap; }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill b { font: 600 12px var(--mono); font-variant-numeric: tabular-nums; }
.pill.live { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, var(--surface)); border-color: color-mix(in srgb, var(--ok) 35%, var(--rule)); }
.pill.failing { color: var(--ng); background: color-mix(in srgb, var(--ng) 10%, var(--surface)); border-color: color-mix(in srgb, var(--ng) 40%, var(--rule)); }
.pill.expired { color: var(--muted); background: var(--sunk); border-color: var(--rule); }
.pill.none { opacity: .55; }
.sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex: none; }
.sw.svc { background: var(--svc); } .sw.push { background: var(--push); } .sw.poll { background: var(--poll); } .sw.webhook { background: var(--webhook); }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--rule); overflow-x: auto; }
.tab { font: 14px var(--sans); background: none; border: 0; border-bottom: 3px solid transparent; padding: 10px 14px; color: var(--muted); cursor: pointer; white-space: nowrap; }
.tab:hover { color: var(--ink); }
.tab[aria-selected="true"] { color: var(--ink); font-weight: 600; border-bottom-color: var(--hub); }
.panel { display: grid; gap: 28px; }
.group { display: grid; gap: 10px; }

.scroll { overflow-x: auto; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
th { font-weight: 600; font-size: 12.5px; color: var(--muted); background: var(--paper); white-space: nowrap; }
td.mono { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
td.num { font-family: var(--mono); font-size: 12.5px; font-variant-numeric: tabular-nums; text-align: right; }
td.wrap { font-family: var(--mono); font-size: 12px; line-height: 1.55; min-width: 22ch; max-width: 56ch; overflow-wrap: anywhere; }
td.empty { color: var(--muted); text-align: center; padding: 20px 12px; }
td.ng { color: var(--ng); font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
time { white-space: nowrap; font-variant-numeric: tabular-nums; }

.defs { display: grid; gap: 8px; }
details.svc { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; }
details.svc summary { cursor: pointer; padding: 10px 14px; font-size: 14px; }
.def { border-top: 1px solid var(--rule); padding: 12px 14px; display: grid; gap: 8px; }
.def-head { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; }
.def-head code { color: var(--hub); font-weight: 600; overflow-wrap: anywhere; }
.def dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; font-size: 13px; }
.def dt { color: var(--muted); }
.def dd { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: 12px/1.7 var(--mono); background: var(--sunk); border-radius: 4px; padding: 0 7px; display: inline-flex; gap: 6px; }
.chip i { font-style: normal; color: var(--muted); }

.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.form-grid .wide { grid-column: 1 / -1; }
.secret { border-color: var(--hub); background: var(--hub-soft); }
.copyrow { display: flex; gap: 8px; }

@media (max-width: 520px) {
  .bar { padding: 12px 16px; }
  main { padding: 16px 16px 64px; }
  .tile .v { font-size: 24px; }
  .card { padding: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`;

// No backticks or template placeholders in here: it is inserted verbatim and hashed for the CSP.
const SCRIPT = String.raw`
"use strict";
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "mcp-events-hub.admin-token";
const BAD_TOKEN = "管理者トークンが違います。ハブを起動したときのHUB_ADMIN_TOKENを入れてください。ハブにHUB_ADMIN_TOKENが設定されていないときも、このエラーになります。";
const STATE = { live: "有効", failing: "失敗中", expired: "期限切れ" };
const EXAMPLE = {
  id: "shop",
  name: "Shop",
  description: "A fake storefront that emits order lifecycle events.",
  events: [
    {
      name: "order.created",
      description: "A customer placed an order.",
      inputSchema: { type: "object", properties: { customer: { type: "string", description: "Only events for this customer." } }, additionalProperties: false },
      payloadSchema: {
        type: "object",
        properties: { order_id: { type: "string" }, customer: { type: "string" }, amount: { type: "integer", description: "Minor currency units." }, currency: { type: "string" } },
        required: ["order_id", "customer", "amount", "currency"],
        additionalProperties: false,
      },
    },
    {
      name: "order.shipped",
      description: "An order left the warehouse.",
      inputSchema: { type: "object", properties: { customer: { type: "string", description: "Only events for this customer." } }, additionalProperties: false },
      payloadSchema: {
        type: "object",
        properties: { order_id: { type: "string" }, customer: { type: "string" }, carrier: { type: "string" } },
        required: ["order_id", "customer", "carrier"],
        additionalProperties: false,
      },
    },
  ],
};

// TODO(auth): the admin token sits in sessionStorage, where any script on this origin can read it. The
// CSP admits only this script, so today that means the hub's own code.
const tokenStore = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } },
  set(value) { try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} },
};
let token = tokenStore.get();
let timer = 0;
let busy = false;
let rendered = {};
const openServices = new Set();

class Unauthorized extends Error {}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, String(v));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

async function api(path, init) {
  const headers = Object.assign({ authorization: "Bearer " + token }, init && init.headers);
  const res = await fetch(path, Object.assign({}, init, { headers, cache: "no-store" }));
  if (res.status === 401) throw new Unauthorized();
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function read(view) {
  const r = await api("/admin/api/" + view);
  if (!r.ok) throw new Error("HTTP " + r.status + " (" + view + ")");
  return r.body;
}

const clock = (d) => d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const none = (label) => h("span", { class: "muted" }, label);
function when(iso, empty) {
  if (!iso) return none(empty);
  const d = new Date(iso);
  return h("time", { datetime: iso, title: iso }, d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
}
const filter = (args) => (Object.keys(args || {}).length ? JSON.stringify(args) : none("なし"));
const td = (cls, ...content) => h("td", cls ? { class: cls } : {}, ...content);

function fill(id, items, empty, row) {
  const body = $(id);
  const cols = body.closest("table").querySelectorAll("thead th").length;
  body.replaceChildren(...(items.length ? items.map(row) : [h("tr", {}, h("td", { class: "empty", colspan: cols }, empty))]));
}

function pill(state, count) {
  return h("span", { class: "pill " + state + (count === 0 ? " none" : "") }, STATE[state], count === undefined ? null : h("b", {}, count));
}

function fields(schema) {
  const props = Object.entries((schema && schema.properties) || {});
  if (!props.length) return [none("なし")];
  return props.map(([name, s]) => h("span", { class: "chip" }, name, h("i", {}, (s && s.type) || "any")));
}

function renderOverview(o) {
  $("o-services").textContent = o.services.toLocaleString();
  $("o-types").textContent = o.eventTypes.toLocaleString();
  $("o-webhooks").textContent = (o.webhooks.live + o.webhooks.failing + o.webhooks.expired).toLocaleString();
  $("o-webhook-states").replaceChildren(pill("live", o.webhooks.live), pill("failing", o.webhooks.failing), pill("expired", o.webhooks.expired));
  $("o-push").textContent = o.pushStreams.toLocaleString();
  $("o-events").textContent = o.events.toLocaleString();
}

function renderServices(list) {
  fill("services-body", list, "登録されたサービスはありません。下のフォームから登録できます。", (s) => h("tr", {},
    td("mono", s.id), td("", s.name), td("", s.description || none("なし")), td("num", s.events.length), td("", when(s.updatedAt, "なし"))));
  $("service-defs").replaceChildren(...list.map((s) => {
    const details = h("details", { class: "svc" },
      h("summary", {}, h("code", {}, s.id), "のイベント定義", h("span", { class: "muted" }, "（" + s.events.length + "件）")),
      ...s.events.map((e) => h("div", { class: "def" },
        h("div", { class: "def-head" }, h("code", {}, s.id + "." + e.name), h("span", {}, e.description)),
        h("dl", {}, h("dt", {}, "フィルタ"), h("dd", {}, fields(e.inputSchema)), h("dt", {}, "payload"), h("dd", {}, fields(e.payloadSchema))))));
    details.open = openServices.has(s.id);
    details.addEventListener("toggle", () => (details.open ? openServices.add(s.id) : openServices.delete(s.id)));
    return details;
  }));
}

function renderSubscriptions(subs) {
  fill("webhooks-body", subs.webhooks, "webhook購読はありません。", (w) => h("tr", {},
    td("", pill(w.state)), td("mono", w.name), td("mono", w.principal), td("wrap", filter(w.arguments)), td("wrap", w.url),
    td("", w.refreshBefore ? when(w.refreshBefore) : none("無期限")), td("", when(w.lastDeliveryAt, "未配信")),
    w.lastError ? td("ng", w.lastError) : td("", none("なし")), td("mono", w.id)));
  fill("push-body", subs.push, "開いているpushストリームはありません。", (p) => h("tr", {},
    td("mono", String(p.id)), td("mono", p.principal), td("mono", p.name), td("wrap", filter(p.arguments)),
    td("", when(p.connectedAt)), td("num", p.cursor)));
}

function renderEvents(events) {
  fill("events-body", events, "まだイベントはありません。", (e) => h("tr", {},
    td("num", e.seq), td("", when(e.timestamp)), td("mono", e.name), td("mono", e.eventId), td("wrap", JSON.stringify(e.data))));
}

function changed(key, value) {
  const text = JSON.stringify(value);
  if (rendered[key] === text) return false;
  rendered[key] = text;
  return true;
}

async function load() {
  const [overview, services, subs, events] = await Promise.all(["overview", "services", "subscriptions", "events?limit=50"].map(read));
  if (changed("overview", overview)) renderOverview(overview);
  if (changed("services", services)) renderServices(services.services);
  if (changed("subscriptions", subs)) renderSubscriptions(subs);
  if (changed("events", events)) renderEvents(events.events);
}

function setStatus(message, bad) {
  $("status").textContent = message;
  $("status").classList.toggle("bad", Boolean(bad));
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    await load();
    setStatus(clock(new Date()) + "に更新");
  } catch (err) {
    if (err instanceof Unauthorized) signOut(BAD_TOKEN);
    else setStatus("更新できませんでした。" + err.message, true);
  } finally {
    busy = false;
  }
}

function setAuto(on) {
  $("auto").checked = on;
  clearInterval(timer);
  timer = on ? setInterval(refresh, 5000) : 0;
}

function showGate(message) {
  setAuto(false);
  $("app").hidden = true;
  for (const id of ["refresh", "auto-wrap", "signout"]) $(id).hidden = true;
  $("gate").hidden = false;
  $("gate-error").hidden = !message;
  $("gate-error").textContent = message || "";
  setStatus("");
  $("token").focus();
}

function signOut(message) {
  token = "";
  tokenStore.set("");
  rendered = {};
  closeSecret();
  showGate(message);
}

async function enter() {
  try {
    await load();
  } catch (err) {
    token = "";
    tokenStore.set("");
    showGate(err instanceof Unauthorized ? BAD_TOKEN : "ハブに接続できません。" + err.message);
    return;
  }
  tokenStore.set(token);
  $("gate").hidden = true;
  $("app").hidden = false;
  for (const id of ["refresh", "auto-wrap", "signout"]) $(id).hidden = false;
  setStatus(clock(new Date()) + "に更新");
}

function closeSecret() {
  $("secret-value").value = "";
  $("copy-status").textContent = "";
  $("secret").hidden = true;
}

function showSecret(result) {
  $("secret-summary").textContent = result.id + "を登録しました。公開したイベントは" + result.events.join("、") + "です。";
  $("secret-id").textContent = result.id;
  $("secret-value").value = result.secret;
  $("secret").hidden = false;
  $("secret-value").focus();
  $("secret-value").select();
}

function registerError(lead, items) {
  const box = $("register-errors");
  box.replaceChildren(h("p", {}, lead), items && items.length ? h("ul", {}, items.map((item) => h("li", {}, item))) : null);
  box.hidden = false;
}

$("gate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  enter();
});

$("signout").addEventListener("click", () => signOut(""));
$("refresh").addEventListener("click", refresh);
$("auto").addEventListener("change", (e) => setAuto(e.target.checked));

$("register").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("register-errors").hidden = true;
  let events;
  try {
    events = JSON.parse($("reg-events").value);
  } catch (err) {
    registerError("イベント定義のJSONを読めません。" + err.message);
    return;
  }
  const body = { name: $("reg-name").value, events };
  if ($("reg-description").value.trim()) body.description = $("reg-description").value.trim();
  const button = $("reg-submit");
  button.disabled = true;
  try {
    const r = await api("/services/" + encodeURIComponent($("reg-id").value), {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      registerError("ハブが登録を受け付けませんでした。次の点を直してから登録し直してください。", String(r.body.error || "HTTP " + r.status).split("; "));
      return;
    }
    showSecret(r.body);
    refresh();
  } catch (err) {
    if (err instanceof Unauthorized) signOut(BAD_TOKEN);
    else registerError("ハブに接続できません。" + err.message);
  } finally {
    button.disabled = false;
  }
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("secret-value").value);
    $("copy-status").textContent = "コピーしました。";
  } catch (err) {
    $("secret-value").select();
    $("copy-status").textContent = "コピーできませんでした。選択した値を手でコピーしてください。";
  }
});
$("secret-close").addEventListener("click", closeSecret);

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    selectTab(tabs[(i + step + tabs.length) % tabs.length], true);
  });
});

const root = document.documentElement;
const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const themeLabel = () => ($("theme").textContent = isDark() ? "ライト表示" : "ダーク表示");
$("theme").addEventListener("click", () => {
  root.dataset.theme = isDark() ? "light" : "dark";
  themeLabel();
});
themeLabel();

$("reg-id").value = EXAMPLE.id;
$("reg-name").value = EXAMPLE.name;
$("reg-description").value = EXAMPLE.description;
$("reg-events").value = JSON.stringify(EXAMPLE.events, null, 2);

if (token) enter();
else showGate("");
`;

export const ADMIN_PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MCP Events Hub管理画面</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar">
  <div class="brand"><span class="eyebrow">MCP EVENTS HUB</span><h1>管理画面</h1></div>
  <div class="actions">
    <span id="status" class="status" role="status" aria-live="polite"></span>
    <label id="auto-wrap" class="toggle" hidden><input id="auto" type="checkbox"><span>5秒ごとに更新</span></label>
    <button id="refresh" class="btn" type="button" hidden>更新</button>
    <button id="theme" class="btn" type="button">ダーク表示</button>
    <button id="signout" class="btn" type="button" hidden>サインアウト</button>
  </div>
</header>

<main id="gate" class="gate">
  <form id="gate-form" class="card">
    <h2>管理者トークンを入力</h2>
    <p class="muted">ハブを起動したときのHUB_ADMIN_TOKENです。このタブを閉じると、ブラウザから消えます。</p>
    <label class="field">管理者トークン<input id="token" type="password" autocomplete="off" required></label>
    <div id="gate-error" class="error" role="alert" hidden></div>
    <button class="btn primary" type="submit">開く</button>
  </form>
</main>

<main id="app" hidden>
  <section class="rollup" aria-label="概要">
    <div class="tile"><span class="k"><span class="sw svc"></span>サービス</span><span id="o-services" class="v">…</span></div>
    <div class="tile"><span class="k">イベント種別</span><span id="o-types" class="v">…</span></div>
    <div class="tile"><span class="k"><span class="sw webhook"></span>webhook購読</span><span id="o-webhooks" class="v">…</span><span id="o-webhook-states" class="pills"></span></div>
    <div class="tile"><span class="k"><span class="sw push"></span>pushストリーム</span><span id="o-push" class="v">…</span></div>
    <div class="tile"><span class="k">保存イベント</span><span id="o-events" class="v">…</span></div>
  </section>

  <div class="tabs" role="tablist" aria-label="表示する内容">
    <button id="tab-services" class="tab" type="button" role="tab" aria-selected="true" aria-controls="panel-services">サービス</button>
    <button id="tab-subscriptions" class="tab" type="button" role="tab" aria-selected="false" aria-controls="panel-subscriptions" tabindex="-1">購読</button>
    <button id="tab-events" class="tab" type="button" role="tab" aria-selected="false" aria-controls="panel-events" tabindex="-1">最近のイベント</button>
  </div>

  <section id="panel-services" class="panel" role="tabpanel" aria-labelledby="tab-services">
    <div class="group">
      <h2>登録済みのサービス</h2>
      <div class="scroll" tabindex="0" role="region" aria-label="サービスの一覧">
        <table>
          <thead><tr><th>ID</th><th>名前</th><th>説明</th><th>イベント数</th><th>更新日時</th></tr></thead>
          <tbody id="services-body"></tbody>
        </table>
      </div>
      <div id="service-defs" class="defs"></div>
    </div>

    <form id="register" class="card">
      <h2>サービスを登録</h2>
      <p class="muted">PUT /services/:idと同じ検証を通ります。同じIDで登録し直すとイベント定義を上書きし、ingest secretはそのまま残ります。</p>
      <div class="form-grid">
        <label class="field">ID<input id="reg-id" required pattern="[a-z0-9]([a-z0-9]|-){0,62}" title="英小文字、数字、ハイフンで63文字まで。先頭は英小文字か数字です。" autocomplete="off" spellcheck="false"></label>
        <label class="field">名前<input id="reg-name" required autocomplete="off"></label>
        <label class="field wide">説明<input id="reg-description" autocomplete="off"></label>
        <label class="field wide">イベント定義（JSONの配列）<textarea id="reg-events" rows="16" spellcheck="false" required></textarea></label>
      </div>
      <div id="register-errors" class="error" role="alert" hidden></div>
      <button id="reg-submit" class="btn primary" type="submit">登録</button>
    </form>

    <section id="secret" class="card secret" aria-labelledby="secret-title" hidden>
      <h2 id="secret-title">登録しました</h2>
      <p id="secret-summary"></p>
      <p>次のingest secretで<code>POST /services/<span id="secret-id"></span>/events</code>の署名を作ります。この画面では1回だけ表示するので、控えてから閉じてください。</p>
      <div class="copyrow"><input id="secret-value" readonly aria-label="ingest secret"><button id="copy" class="btn" type="button">コピー</button></div>
      <p id="copy-status" class="muted" role="status"></p>
      <button id="secret-close" class="btn" type="button">控えたので閉じる</button>
    </section>
  </section>

  <section id="panel-subscriptions" class="panel" role="tabpanel" aria-labelledby="tab-subscriptions" hidden>
    <div class="group">
      <h2><span class="sw webhook"></span>webhook購読</h2>
      <p class="muted">events/subscribeで作られた購読です。ハブはイベントをcallback URLへ署名付きでPOSTします。</p>
      <div class="scroll" tabindex="0" role="region" aria-label="webhook購読の一覧">
        <table>
          <thead><tr><th>状態</th><th>イベント</th><th>principal</th><th>フィルタ</th><th>callback URL</th><th>期限</th><th>最終配信</th><th>最終エラー</th><th>ID</th></tr></thead>
          <tbody id="webhooks-body"></tbody>
        </table>
      </div>
    </div>
    <div class="group">
      <h2><span class="sw push"></span>pushストリーム</h2>
      <p class="muted">いま開いているevents/streamです。クライアントが接続を切ると一覧から消えます。</p>
      <div class="scroll" tabindex="0" role="region" aria-label="pushストリームの一覧">
        <table>
          <thead><tr><th>リクエストID</th><th>principal</th><th>イベント</th><th>フィルタ</th><th>接続時刻</th><th>送信済みcursor</th></tr></thead>
          <tbody id="push-body"></tbody>
        </table>
      </div>
    </div>
    <div class="group">
      <h2><span class="sw poll"></span>poll</h2>
      <p class="muted">pollはハブに状態を残しません。クライアントが呼ぶたびにcursorを渡すだけなので、ここに出せる一覧はありません。</p>
    </div>
  </section>

  <section id="panel-events" class="panel" role="tabpanel" aria-labelledby="tab-events" hidden>
    <div class="group">
      <p class="muted">イベントログの新しい順に、最大50件を表示します。</p>
      <div class="scroll" tabindex="0" role="region" aria-label="最近のイベント">
        <table>
          <thead><tr><th>seq</th><th>時刻</th><th>イベント</th><th>eventId</th><th>data</th></tr></thead>
          <tbody id="events-body"></tbody>
        </table>
      </div>
    </div>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const ADMIN_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": [
    "default-src 'none'",
    `script-src ${sha256(SCRIPT)}`,
    `style-src ${sha256(STYLE)}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};
