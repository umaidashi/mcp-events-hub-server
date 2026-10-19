# mcp-events-hub-server

[MCP Events](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md) を中継するハブです。上流サービスは自前の MCP Events サーバーを作らず、イベント定義の登録と署名付き webhook の送信だけを実装します。クライアントエージェントはハブ 1 か所に接続し、全サービスのイベントを 1 つのカタログから購読します。

```
upstream service ──PUT /services/:id (catalog)──▶ ┌────────────┐ ──webhook (events/subscribe)──▶ ChatGPT
upstream service ──POST /services/:id/events───▶ │ events hub │ ◀─events/stream (push, SSE)──── pi, other agents
                   (Standard Webhooks signed)     └────────────┘ ◀─events/poll──────────────────── any MCP client
```

ハブの中身は追記専用のイベントログです。poll、push、webhook の 3 つの配信方式は同じログを読み、cursor はログの連番です。webhook しか受けられない ChatGPT も、公開 URL を持たない pi のようなローカルエージェントも、同じイベントを受け取れます。

依存パッケージはありません。Node.js 24 以上で `.ts` をそのまま実行します。

## 動かす

```sh
HUB_ADMIN_TOKEN=dev-admin HUB_CLIENT_TOKENS=pi:dev-client HUB_ALLOW_PRIVATE_CALLBACKS=1 npm start
npm run mock -- register                     # shop サービスを登録し .data/shop.secret に保存
npm run mock -- emit order.created '{"order_id":"o-1","customer":"alice","amount":1200,"currency":"JPY"}'
npm run mock -- loop 5                        # 5 秒ごとにランダムな注文を送る
```

pi から使うには拡張を読み込みます。

```sh
MCP_EVENTS_HUB_URL=http://127.0.0.1:8787/mcp MCP_EVENTS_HUB_TOKEN=dev-client pi --extension pi/mcp-events.ts
```

pi のモデルには `events_catalog`、`events_subscribe`、`events_unsubscribe` の 3 つのツールが見えます。「shop.order.created を customer=alice で購読して、届いたら金額を報告して」のように頼むと、イベントが届くたびに新しいターンが始まります。

## 設定

| 環境変数 | 既定値 | 内容 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 待ち受けアドレス |
| `HUB_DB` | `.data/hub.db` | SQLite ファイル。`:memory:` も可 |
| `HUB_ADMIN_TOKEN` | なし | サービス登録用の Bearer トークン。未設定なら登録できない |
| `HUB_CLIENT_TOKENS` | なし | `principal:token,...`。未設定なら全員 `anonymous` になり、webhook 購読は拒否される |
| `HUB_ALLOW_PRIVATE_CALLBACKS` | なし | `1` で http とプライベートアドレスへの callback を許可する(開発用) |

## サービス側の API

サービスの実装はこの 2 つだけです。

`PUT /services/:id` は `Authorization: Bearer $HUB_ADMIN_TOKEN` 付きでイベント定義を登録します。応答の `secret` で ingest を署名します。再登録しても secret は変わりません。

```json
{ "name": "Shop", "events": [{
  "name": "order.created", "description": "A customer placed an order.",
  "inputSchema":   { "type": "object", "properties": { "customer": { "type": "string" } } },
  "payloadSchema": { "type": "object", "properties": { "order_id": {"type":"string"}, "customer": {"type":"string"} },
                     "required": ["order_id", "customer"] } }] }
```

`inputSchema` の各プロパティは、同名の payload フィールドとの完全一致フィルタです。payload に存在しないフィルタは登録時に拒否します。クライアントには `<service id>.<event name>` という名前で公開します。

`POST /services/:id/events` は [Standard Webhooks](https://www.standardwebhooks.com) 形式(`webhook-id`、`webhook-timestamp`、`webhook-signature`)で署名した `{ "name", "data", "eventId"?, "timestamp"? }` を受け取ります。`eventId` を省くと `webhook-id` を使います。同じ `eventId` の再送は 1 回だけ記録します。

## クライアント側の MCP

`POST /mcp` は 2026-07-28(`server/discover`、リクエストごとの `_meta`)と 2025-11-25 以前(`initialize`)の両方を受け付けます。

| メソッド | 用途 |
|---|---|
| `events/list` | 全サービスのイベントカタログ。全イベントが `webhook`、`push`、`poll` に対応する |
| `events/subscribe` / `events/unsubscribe` | webhook 購読。callback の challenge 検証、TTL、署名付き配信、指数バックオフの再送(410 と 413 は再送しない)を行う |
| `events/stream` | push。SSE で `active`、`event`、`heartbeat` を送る |
| `events/poll` | poll。`cursor`、`hasMore`、`nextPollMs` を返す |

## 検証

- `npm test` は 27 件のテストで、実際の HTTP 越しに両方の世代のハンドシェイク、ingest、3 つの配信方式、署名検証、再送、challenge 失敗を確認します。
- `node scripts/pi-demo.ts` は実際の LLM で pi を動かします。pi がカタログを見て alice の注文だけを購読し、bob の注文には反応せず、alice の注文で `ORDER o-alice-1 4200 JPY` と返すことを確認します。モデルは `PI_DEMO_MODEL` で変えられます。

## まだやっていないこと

- ChatGPT からの実接続は試していません。公開 HTTPS と、ChatGPT のプラグイン設定が必要です。ChatGPT の webhook 購読には認証済みの principal が要るので、静的 Bearer トークンを OAuth に置き換える必要があります。
- ChatGPT のドキュメントは callback 検証失敗に `-32015` を使っています。ハブは設計スケッチの最新版にあわせて `-32027` を返します。
- webhook 本文の `cursor` はそのイベント自身の連番です。未確認応答の最小値ではありません。
- `gap` と `terminated` の通知、`notifications/events/list_changed`、`events/list` のページング、secret ローテーション時の二重署名、失敗率による配信停止は実装していません。
- callback 先のアドレスは名前解決したうえでプライベートアドレスを拒否しますが、接続先を固定していません。そのため DNS rebinding の余地があります。
- JSON Schema の検証は `type`、`properties`、`required`、`additionalProperties: false`、`enum`、`items` だけです。
