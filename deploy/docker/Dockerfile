# Node adapter 執行映像。
#
# 不做 tsc 編譯：本專案 tsconfig 刻意採 module=preserve＋moduleResolution=bundler
# （與 Cloudflare Worker 打包路徑共用同一份原始碼），相對匯入一律無 .js 副檔名、
# 另有 @open4wd/* 路徑別名——tsc 產出的 JS 這兩者都不會改寫，Node 無法直接執行。
# 因此執行期保留 tsx（0.5 MB）直跑 TS，其餘工具鏈一律不進映像。
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

# 只安裝 dependencies：把 wrangler／typescript／prettier／eslint／vitest（約 55 MB）
# 擋在映像外。wrangler 尤其不該出現在對外服務的執行環境——它是 Cloudflare 憑證載體。
# 先複製 manifest 再安裝，原始碼變更才不會使相依層失效。pnpm-workspace.yaml 必須一併進映像：
# 它宣告 allowBuilds（esbuild＝tsx 的執行期建置器），缺它時 pnpm 11 對未核可的相依建置腳本
# 直接以 ERR_PNPM_IGNORED_BUILDS 中止安裝。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

# 只複製執行期真正需要的原始碼（其餘由 .dockerignore 擋下）。tsconfig.json 必須進映像：
# vendored 協定檔以 @open4wd/* 路徑別名匯入 shim，tsx 依 cwd 的 tsconfig paths 解析，缺它
# 則 ERR_MODULE_NOT_FOUND 啟動即崩。
COPY tsconfig.json ./
COPY core ./core
COPY adapters ./adapters

# 以非 root 執行：node 官方映像預設 root，對外開 WebSocket 的行程不該有 root。
RUN chown -R node:node /app
USER node

EXPOSE 8080
# 執行期由 node 直接執行 tsx 的 cli、指向與 package.json start script 同一入口，不經 pnpm／corepack：
# corepack 的 pnpm 快取是 per-user，USER 切換後為空，`pnpm start` 會在每次啟動時重新下載 pnpm
# （需要網路與可寫的 HOME）。CMD 與 start script 的同步由 deploy/dockerfile.spec.ts 守門。
CMD ["node", "node_modules/tsx/dist/cli.mjs", "adapters/node/server.ts"]
