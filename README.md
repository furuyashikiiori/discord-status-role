# discord-status-role

iPhone のショートカットから叩くと、Discord サーバーで自分に「💤睡眠中」「🚶外出中」などのロールを付け外しする Cloudflare Worker。
Bot アカウントの公式 API だけを使うので規約上問題なし。サーバーオーナーにも使える。

```
睡眠モード ON/OFF ─┐
自宅を出発/到着 ───┼─▶ iPhoneショートカット ─▶ Worker ─▶ Discord API（ロール付け外し）
```

## エンドポイント

| パス | 動作 |
|---|---|
| `POST /<status>/on`  | そのステータスのロールを付与 |
| `POST /<status>/off` | そのステータスのロールを外す |
| `POST /<status>/on?hours=3` | 付与して 3 時間後に自動で外す（小数可・最大 72） |
| `POST /<status>/on?until=07:30` | 付与して次の 07:30 に自動で外す |
| `POST /sleep` / `POST /wake` | `/sleep/on` / `/sleep/off` の別名 |

すべて `Authorization: Bearer <SHARED_SECRET>` ヘッダが必要。
`<status>` は `ROLES` に書いた名前（`sleep`, `away` など。自由に追加可）。

## セットアップ

### 1. Discord 側

1. [Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → **Reset Token** でトークンを控える
2. **OAuth2 → URL Generator** で scope `bot`、権限 **Manage Roles（ロールの管理）** を選び、出てきた URL でサーバーに招待
3. サーバーにロール「💤睡眠中」「🚶外出中」を作る
   - 「オンラインメンバーとは別にロールメンバーを表示する」を ON にするとメンバー一覧で分かれて見える
4. ロール一覧で **Bot のロールをこれらのロールより上** にドラッグ
5. Discord の設定 → 詳細設定 → **開発者モード** ON にして、自分のユーザーID・サーバーID・ロールIDを右クリックでコピー

### 2. 設定値

`wrangler.toml` の `[vars]` を書き換える：

```toml
USER_ID = "123456789012345678"
ROLES = '{"sleep":"サーバーID:睡眠ロールID","away":"サーバーID:外出ロールID"}'
```

複数サーバーなら `"sleep":"サーバーA:ロールA,サーバーB:ロールB"` のようにカンマ区切り。

#### 自動オフ

`AUTO_OFF` に書いたステータスは、`on` したあと指定の時刻（日本時間）に自動で外れる。
`?hours=` / `?until=` を付けて `on` するとそちらが優先される。どのステータスにも付けられる。

```toml
AUTO_OFF = '{"busy":"05:00"}'   # 「今日は遊べない」は翌朝5時に自動で外す
```

予約は KV（`STATE`）に保存し、Cron（5分おき）で期限切れを外す。なので外れるのは最大 5 分ほど遅れる。
手動で `off` するか、時刻指定なしで `on` し直すと予約は消える。
KV は `npx wrangler kv namespace create STATE` で作り、出てきた id を `wrangler.toml` の `[[kv_namespaces]]` に書く。

### 3. デプロイ

```bash
npm install
npx wrangler login
npx wrangler secret put BOT_TOKEN       # Bot トークンを貼り付け
npx wrangler secret put SHARED_SECRET   # 長いランダム文字列（例: openssl rand -hex 32 の出力）
npm run deploy
```

表示された `https://discord-status-role.<アカウント>.workers.dev` を控える。

### 4. 動作確認

```bash
URL=https://discord-status-role.xxxx.workers.dev
SECRET=さっきの合言葉
curl -X POST -H "Authorization: Bearer $SECRET" $URL/sleep/on
curl -X POST -H "Authorization: Bearer $SECRET" $URL/sleep/off
```

### 5. iPhone ショートカット（オートメーション）

各オートメーションのアクションは「**URLの内容を取得**」：
- 方法: `POST`
- ヘッダ: `Authorization` = `Bearer 合言葉`
- 「**すぐに実行**」を ON（確認なしで動かすため）

| トリガー | URL |
|---|---|
| 集中モード「睡眠」がオンになったとき | `…/sleep/on` |
| 集中モード「睡眠」がオフになったとき | `…/sleep/off` |
| 「出発」：自宅 | `…/away/on` |
| 「到着」：自宅 | `…/away/off` |
| 「到着」：バイト先 | `…/work/on` |
| 「出発」：バイト先 | `…/work/off` |

#### 手動で使うもの（今日は遊べない など）

オートメーションではなく普通のショートカットとして作り、ホーム画面・ウィジェット・背面タップ・Siri から実行する。

- 「今日は遊べない」: `…/busy/on`（`AUTO_OFF` で翌朝5時に自動解除）
- 「◯時間 起こさないで」: 「入力を要求（数字）」→ URL を `…/busy/on?hours=〔入力した数字〕` にする
- 「やっぱり遊べる」: `…/busy/off`

Apple Watch は就寝スケジュールに合わせて睡眠集中モードに入るので、それがトリガーになる。
位置情報トリガーは数分遅れることがある。設定 → プライバシー → 位置情報サービス → ショートカット を「常に」にすると安定しやすい。

## トラブルシューティング

| 返ってきたもの | 原因 |
|---|---|
| `500 Server is not configured` | `BOT_TOKEN` / `SHARED_SECRET` / `USER_ID` のどれかが未設定 |
| `401` | `SHARED_SECRET` とヘッダの合言葉が不一致（`Bearer ` の後ろのスペース忘れも多い） |
| `400` | `hours` が 0 以下・72 超、または `until` が `HH:MM` 形式でない |
| `500 Auto-off needs the STATE KV binding` | 自動オフを使おうとしたが KV がバインドされていない |
| `404` | パスの status 名が `ROLES` に無い / `on`・`off` のつづり違い |
| `500 ROLES is not valid JSON` | `ROLES` の JSON が壊れている |
| `502` で中身に `"status":403` / `50013` | Bot に Manage Roles 権限が無い、または Bot のロールが対象ロールより下 |
| `502` で中身に `"status":404` | サーバーID・ロールID・ユーザーIDの間違い、または Bot がそのサーバーにいない |

ログは `npx wrangler tail` で見られる。
