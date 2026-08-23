# open-4wd-signaling

Open4WD 的 WebRTC signaling 公版實作，交換 SDP 與 ICE candidate 以協助瀏覽器建立 P2P
連線；連線建立後即退出資料路徑，不參與遊戲資料傳輸。

> 本專案仍在開發中；Open4WD 主遊戲尚未正式公開。本 repo 先提供可審查、可自行部署的
> 服務模板，不代表官方營運中的節點。

本 repo 不保存營運者 secrets，也不代表任何部署。營運者 fork 可手動 opt in 部署 workflow。

## 快速開始

前置需求：Node.js 24 與 pnpm 11。

```sh
pnpm install --frozen-lockfile
pnpm start
```

Node adapter 預設監聽 8080，端點為 `/ws?room=<canonical scope>`；scope 只接受
`room:<小寫 UUID v4>` 或 `match:<64 字元小寫 hex digest>`。

Cloudflare Worker 本機驗證：

```sh
pnpm worker:types:check
pnpm e2e
pnpm worker:dry-run
```

Worker 使用 SQLite-backed Durable Objects 保存短期成員順序、限流與 replay nonce，不保存
SDP／ICE。完整 Cloudflare 操作與營運者責任見
[deploy/cloudflare/README.md](deploy/cloudflare/README.md)。

## 規格與架構

平台無關核心位於 `core/`，Node／Cloudflare 傳輸適配器位於 `adapters/`。兩者共用
canonical scope、register proof、signed `signal-v1` 與 TURN token 協定。

規範常數本機比對：

```sh
pnpm check:constants
```

此命令依 Specs `scripts/parameter-authorities.json` 發現程式參數 authority，並比對
`程式參數/network.md` §9 與 `core/constants.ts` 的 5 項 signaling default；authority
檔案總數不是契約。預設讀取 sibling `../open-4wd-specs`，非 sibling workspace 可設定
`O4_SPECS_DIR`。一般測試不依賴 Specs。

`core/protocol/vendor/` 由主專案同步並以 manifest/hash 驗證；不要手改。先以
`pnpm check:vendor:local` 驗本機 closure，完整 release gate 才使用 `pnpm check:vendor`。

## 部署入口

根 README 不複製完整 secrets、env 與 Cloudflare runbook：

- Cloudflare Worker：[就地操作手冊](deploy/cloudflare/README.md)
- Node Docker：[docker-compose.yml](deploy/docker/docker-compose.yml)
- Signaling＋TURN 單機：[docker-compose.all-in-one.yml](deploy/docker/docker-compose.all-in-one.yml)
- TURN 節點：[open-4wd-turn](https://github.com/xjustloveux/open-4wd-turn)
- 跨 repo 規格：[open-4wd-specs 部署資訊](https://github.com/xjustloveux/open-4wd-specs/tree/master/%E9%83%A8%E7%BD%B2%E8%B3%87%E8%A8%8A)

部署後以 `pnpm exec tsx scripts/smoke.ts wss://你的網域` 驗證。任何 Cloudflare account、
route、custom domain、API Token、`INTERNAL_HMAC_SECRET` 或 TURN secret 只屬營運者環境。

## 驗證

```sh
pnpm format:check
pnpm lint
pnpm check:types
pnpm test
pnpm test:scripts
pnpm e2e
pnpm check:vendor:local
pnpm check:comments:self-test
pnpm check:comments
```

## Open4WD 生態

- [主遊戲](https://github.com/xjustloveux/open-4wd)
- [規格](https://github.com/xjustloveux/open-4wd-specs)
- [Pinning Template](https://github.com/xjustloveux/open-4wd-pinning)
- [TURN Template](https://github.com/xjustloveux/open-4wd-turn)

## 貢獻、安全與授權

一般貢獻請使用 GitHub Issue／Pull Request；安全弱點請依
[Open4WD Security Reporting](https://github.com/xjustloveux/open-4wd-specs/blob/master/%E8%B3%87%E5%AE%89%E8%A6%8F%E7%AF%84.md#101-reporting)
私下回報，不要公開揭露細節。

[MIT](LICENSE)
