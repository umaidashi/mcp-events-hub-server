# mcp-events-hub-server

[MCP Events](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md) を中継するハブです。上流サービスは自前の MCP Events サーバーを作らず、イベント定義の登録と署名付き webhook の送信だけを実装します。クライアントエージェントはハブ 1 か所に接続し、全サービスのイベントを 1 つのカタログから購読します。

```
upstream service ──PUT /services/:id (catalog)──▶ ┌────────────┐ ──webhook (events/subscribe)──▶ ChatGPT
upstream service ──POST /services/:id/events───▶ │ events hub │ ◀─events/stream (push, SSE)──── pi, other agents
                   (Standard Webhooks signed)     └────────────┘ ◀─events/poll──────────────────── any MCP client
```

ハブの中身は追記専用のイベントログです。poll、push、webhook の 3 つの配信方式は同じログを読み、cursor はログの連番です。webhook しか受けられない ChatGPT も、公開 URL を持たない pi のようなローカルエージェントも、同じイベントを受け取れます。

ハブ本体は Web 標準の `Request` と `Response` を受け渡す 1 つの fetch ハンドラ(`src/hub.ts`)です。同じコードを Node.js(`src/node.ts`)と Cloudflare Workers の Durable Object(`src/worker.ts`)で動かします。Node.js で動かすときの依存パッケージはなく、Node.js 24 以上で `.ts` をそのまま実行します。Cloudflare 向けの開発とビルドには devDependencies の `cf`、`@cloudflare/vite-plugin`、`vite` を使います。

設計と使い方を図にしたページは [`docs/mcp-events-hub.html`](docs/mcp-events-hub.html) です。ブラウザで直接開けます。

## Node.js で動かす

```sh
HUB_ADMIN_TOKEN=dev-admin HUB_CLIENT_TOKENS=pi:dev-client HUB_ALLOW_PRIVATE_CALLBACKS=1 npm start
npm run mock -- register                     # shop サービスを登録し .data/shop.secret に保存
npm run mock -- emit order.created '{"order_id":"o-1","customer":"alice","amount":1200,"currency":"JPY"}'
npm run mock -- loop 5                        # 5 秒ごとにランダムな注文を送る
```

pi から使うには、拡張を pi のパッケージとしてインストールします。このリポジトリの `package.json` が pi パッケージの定義を兼ねていて、`pi/mcp-events.ts` を拡張として読み込みます。インストールしても、ハブ側の開発用の依存(`cf`、`vite` など)は入りません。

```sh
pi install git:github.com/umaidashi/mcp-events-hub-server   # GitHub から
pi install /path/to/mcp-events-hub-server                   # 手元のクローンから(コピーせずにそのまま読む)
```

拡張はハブの場所とトークンを環境変数から読みます。シェルの設定ファイルに書いておくと、pi を起動するたびに指定せずに済みます。

```sh
export MCP_EVENTS_HUB_URL=http://127.0.0.1:8787/mcp
export MCP_EVENTS_HUB_TOKEN=dev-client
pi
```

インストールせずに 1 回だけ試すときは `pi --extension pi/mcp-events.ts` で読み込めます。外すときは `pi remove git:github.com/umaidashi/mcp-events-hub-server` です。

pi のモデルには `events_catalog`、`events_subscribe`、`events_unsubscribe` の 3 つのツールが見えます。「shop.order.created を customer=alice で購読して、届いたら金額を報告して」のように頼むと、イベントが届くたびに新しいターンが始まります。

拡張は既定で push を使い、ハブが push を出していなければ poll を使います。`MCP_EVENTS_DELIVERY` で配信方式を固定できます。

| 環境変数 | 既定値 | 内容 |
|---|---|---|
| `MCP_EVENTS_DELIVERY` | push、なければ poll | `push`、`poll`、`webhook` のどれか。ハブが出していない方式を選ぶと購読ツールがエラーを返す |
| `MCP_EVENTS_CALLBACK_PORT` | `0`(空きポート) | webhook の受け口を開く 127.0.0.1 のポート |
| `MCP_EVENTS_TTL_MS` | `3600000` | webhook 購読に求める TTL。残り時間の 8 割が過ぎたら最新の cursor で `events/subscribe` を呼び直す |

webhook を選ぶと、拡張は最初の購読で 127.0.0.1 に HTTP サーバーを開き、購読ごとに `/callback/<n>` と `whsec_` secret を作って `events/subscribe` に渡します。ChatGPT と同じ経路をローカルで通すためのもので、ハブは `HUB_ALLOW_PRIVATE_CALLBACKS=1` で起動します。受け口は Standard Webhooks の署名を 5 分の許容幅で検証し、challenge に応答し、イベントを eventId で重複排除します。購読を解除すると `events/unsubscribe` を呼び、最後の購読が終わったらサーバーを閉じます。

## Cloudflare で動かす

Cloudflare 版は Worker 1 つと SQLite ストレージの Durable Object `EventsHub` 1 つで動きます。Worker は受けたリクエストをすべて `EventsHub` に渡し、ハブは Durable Object の SQLite にイベントログ、サービス、購読を保存します。構成は `cloudflare.config.ts` に、開発サーバーの設定は `vite.config.ts` に書いてあります。

```sh
npm install
cp .dev.vars.example .dev.vars    # HUB_ADMIN_TOKEN と HUB_CLIENT_TOKENS(git 管理外)
npm run cf:dev                     # cf dev。http://127.0.0.1:5173 で待ち受ける
HUB_URL=http://127.0.0.1:5173 npm run mock -- register
```

`cf dev` はローカルの workerd でハブを動かし、Durable Object のデータを `.cloudflare/state/` に保存します。Worker が読む秘密情報は `.dev.vars` の `HUB_ADMIN_TOKEN` と `HUB_CLIENT_TOKENS` だけです。`.env` にある `ANTHROPIC_API_KEY` などは Worker に渡りません。`cf dev` は development モードで動き、ローカルの webhook 受け口に届くよう `HUB_ALLOW_PRIVATE_CALLBACKS` を `1` にします。ビルドとデプロイでは `0` です。

```sh
npm run cf:build                                          # .cloudflare/output/v0/ に Build Output を作る。認証は不要
npx cf deploy --dry-run                                   # アップロードせずにビルドと検証だけ行う
npm run cf:deploy -- --secrets-file <秘密情報のファイル>     # .dev.vars と同じ形式のファイルで秘密情報も一緒に送る
npm run cf:types                                          # .cloudflare/types/index.d.ts に Env とランタイムの型を書き出す
```

デプロイには `cf auth login` か `CLOUDFLARE_API_TOKEN` が必要です。`.cloudflare/` はビルドと型の生成物なので git 管理外です。

## 管理画面

ハブを起動したら、ブラウザで `/admin`(Node.js なら http://127.0.0.1:8787/admin、`cf dev` なら http://127.0.0.1:5173/admin)を開きます。最初に `HUB_ADMIN_TOKEN` の値を入れると、そのタブを閉じるまでブラウザの sessionStorage に保存します。

画面の上段には、サービス数、イベント種別の数、webhook 購読の数(有効、失敗中、期限切れの内訳)、開いている push ストリームの数、保存したイベントの数が並びます。その下の 3 つのタブで詳細を確認します。

- サービス。登録済みのサービスと、イベントごとのフィルタと payload のフィールドを一覧します。フォームから `PUT /services/:id` と同じ検証でサービスを登録できます。登録に成功すると ingest secret を 1 回だけ表示します。
- 購読。webhook 購読の状態、principal、フィルタ、callback URL、期限、最終配信、最終エラーと、いま開いている push ストリームを一覧します。poll はハブに状態を残さないので一覧はありません。
- 最近のイベント。イベントログを新しい順に 50 件表示します。

画面が読む API は `GET /admin/api/overview`、`/admin/api/services`、`/admin/api/subscriptions`、`/admin/api/events?limit=50`(最大 200)で、どれも `Authorization: Bearer $HUB_ADMIN_TOKEN` が必要です。ingest secret と webhook の secret はどの API も返しません。

## 設定

| 環境変数 | 既定値 | 内容 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Node.js の待ち受けアドレス |
| `HUB_DB` | `.data/hub.db` | Node.js の SQLite ファイル。`:memory:` も可 |
| `HUB_ADMIN_TOKEN` | なし | サービス登録と管理画面の Bearer トークン。未設定なら登録も管理画面の API も使えない |
| `HUB_CLIENT_TOKENS` | なし | `principal:token,...`。未設定なら全員 `anonymous` になり、webhook 購読は拒否される |
| `HUB_ALLOW_PRIVATE_CALLBACKS` | なし | `1` で http とプライベートアドレスへの callback を許可する(開発用) |

Cloudflare では `HUB_ADMIN_TOKEN` と `HUB_CLIENT_TOKENS` を秘密情報として、`HUB_ALLOW_PRIVATE_CALLBACKS` を `cloudflare.config.ts` の値として渡します。`PORT`、`HOST`、`HUB_DB` は使いません。

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

- `npm test` は 37 件のテストで、LLM を使いません。`test/hub.test.ts` は実際の HTTP 越しに両方の世代のハンドシェイク、ingest、3 つの配信方式、署名検証、再送、challenge 失敗、管理画面の API と CSP を確認します。`test/pi-extension.test.ts` は pi の拡張のツールを直接呼び、push、poll、webhook のそれぞれで、条件に合うイベントだけが届き、購読解除後は届かないことと、webhook 受信口が偽造や古い署名を拒否することを確認します。
- `node scripts/smoke.ts <ハブの URL>` は動いているハブに HTTP で接続し、`server/discover`、shop の登録、署名が違う ingest の拒否、poll(alice には届き bob には届かない)、push の `active` と配信、webhook の challenge と署名付き配信と購読解除を確認します。結果を 1 行ずつ出し、すべて通れば終了コード 0 です。トークンは `HUB_ADMIN_TOKEN`(既定 `dev-admin`)と `HUB_CLIENT_TOKEN`(既定 `dev-client`)で渡します。
  - `PI_DEMO_INSTALLED=1` を付けると、`--extension` を使わず、デモ用の設定ディレクトリ `.data/pi-agent` にインストールした拡張を読み込みます。先に `PI_CODING_AGENT_DIR=$PWD/.data/pi-agent pi install $PWD` でインストールしておきます。webhook の確認には、127.0.0.1 への http callback を許すハブが必要です。`npm start` を上の例どおりに起動した場合と、`npm run cf:dev` の場合はそのまま通ります。
- `node scripts/pi-demo.ts` は実際の LLM で pi を動かします。push、poll、webhook の順に、毎回新しいハブと pi を起動します。pi がカタログを見て alice の注文だけを購読し、bob の注文には反応せず、指定した方式で届いた alice の注文で `ORDER o-alice-1 4200 JPY` と返すことを確認します。方式ごとに PASS か FAIL を 1 行出し、1 つでも落ちたら終了コード 1 で終わります。
  - 既定のモデルは `anthropic/claude-haiku-5-5` で、`ANTHROPIC_API_KEY` が必要です。リポジトリ直下の `.env`(git 管理外)に `ANTHROPIC_API_KEY=sk-ant-...` と書き、`npm run demo` で実行します。スクリプトは空の `.data/pi-agent` を `PI_CODING_AGENT_DIR` として pi に渡すので、`~/.pi/agent/auth.json` の claude.ai ログインは使わず、API キーだけで動きます。
  - `PI_DEMO_DELIVERY=push|poll|webhook|all` で方式を絞れます。`PI_DEMO_MODEL=openai-codex/gpt-5.6-luna` のように Anthropic 以外を指定すると、`~/.pi/agent` のログイン情報を使います。
  - `PI_DEMO_HUB_URL=http://127.0.0.1:5173 npm run demo` のように URL を渡すと、ハブを起動せずにそのハブを使います。トークンは `HUB_ADMIN_TOKEN`(既定 `dev-admin`)と `HUB_CLIENT_TOKEN`(既定 `dev-client`)で渡します。
  - `PI_DEMO_INSTALLED=1` を付けると、`--extension` を使わず、デモ用の設定ディレクトリ `.data/pi-agent` にインストールした拡張を読み込みます。先に `PI_CODING_AGENT_DIR=$PWD/.data/pi-agent pi install $PWD` でインストールしておきます。
