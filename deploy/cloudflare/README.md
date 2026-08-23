# Cloudflare Workers 公版部署範本

本目錄是 `open-4wd-signaling` 的可重現部署範例，不代表任何線上服務。

本 repo 提供可重用的 signaling 實作、部署範例與驗證，但不保存營運者 secrets，也不代表任何線上部署。每個營運者 fork 自行決定 endpoint、網域與可用性政策，並由該 fork 的 Actions secrets／variables 注入正式 binding。

## 公版責任

- 同時提供 Cloudflare Worker 與 Node adapter。
- 以 SQLite-backed Durable Objects 保存短期限流、成員順序及 replay nonce。
- CI 執行測試、`wrangler types --check` 與 `wrangler deploy --dry-run`。
- 不保存 Cloudflare 帳號、route、custom domain、TURN secret 或任何營運者憑證。
- 隨 repo 提供 dispatch-only、`DEPLOY_ENABLED` opt-in 的 fork 部署 workflow；公版未啟用，
  不會自行部署線上服務。

## 營運者責任

營運者可 fork、使用 template，或在任意可重現的部署環境引用固定 commit／tag。
下列資料只屬於該營運者，不進入公版：

- Cloudflare Account ID 與最小權限 API Token；
- custom domain 與 route；
- `INTERNAL_HMAC_SECRET`；
- 選配的 `TURN_SHARED_SECRET`、`TURN_URLS`；
- `ADMISSION_LIMIT_PER_MIN`、`TURN_RATE_LIMIT_PER_MIN` 等正式限流值；
- GitHub Environment 或其他發布系統的人工核准與保護規則。

公版 `wrangler.jsonc` 不寫入 account、route、custom domain 或 zone 綁定。

一般正式流程為：fork → 在 Actions secrets 設 `CLOUDFLARE_API_TOKEN`、
`CLOUDFLARE_ACCOUNT_ID`、`INTERNAL_HMAC_SECRET` → 在 Actions variables 設
`DEPLOY_ENABLED=true` → 手動執行 Deploy operator fork。流程會 frozen install →
測試／型別檢查 → Wrangler dry-run → secret binding 注入 → `wrangler deploy`。
TURN 選配值必須成對設定：secret `TURN_SHARED_SECRET` 與 variable `TURN_URLS`；workflow
會把兩者注入 Worker binding，避免只存在 runner shell。預設使用 workers.dev；自訂網域在
Cloudflare Dashboard 設定，無需修改 `wrangler.jsonc`。

## 社群自架

社群可 fork 公版並選擇：

- 免費額度內的 Cloudflare Workers＋SQLite-backed Durable Objects；或
- `adapters/node` 的 Node WebSocket 服務。

Cloudflare 部署者須自行建立私有 secret 與 route。請勿把 `.dev.vars`、API Token、
TURN secret 或真實網域設定提交到公版。

## 本機驗證

```text
pnpm install --frozen-lockfile
pnpm worker:types:check
pnpm test
pnpm e2e
pnpm worker:dry-run
```

`worker:dry-run` 只打包並驗證，不會連線部署 Cloudflare。
