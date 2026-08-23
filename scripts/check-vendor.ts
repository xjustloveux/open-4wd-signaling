/**
 * 雙層 vendored 檢查：
 *  1. 本地完整性 —— 檔案 sha256 須與 MANIFEST 相符（擋手改 vendored 檔），永遠執行。
 *  2. 上游漂移 —— 抓上游原檔比對（擋上游變動）；本機取不到時警告跳過，CI 環境則失敗。
 * 以 --write 重新計算並寫回 MANIFEST 的 sha256（僅在刻意同步上游後使用）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchVendorText, formatRemoteFailures, type RemoteFailure } from './vendor-remote';
import { sha256, type VendorManifest as Manifest } from './vendor-manifest';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'core', 'protocol', 'vendor');
const manifestPath = join(vendorDir, 'MANIFEST.json');

export interface VendorOptions {
  readonly write: boolean;
  readonly localOnly: boolean;
}

export function parseVendorOptions(argv: readonly string[]): VendorOptions {
  return {
    write: argv.includes('--write'),
    localOnly: argv.includes('--local-only'),
  };
}

export function shouldCheckUpstream(options: VendorOptions): boolean {
  return !options.localOnly;
}

export async function runVendorCheck(
  argv: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const options = parseVendorOptions(argv);
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const isCi = process.env['CI'] === 'true';
  const failures: string[] = [];
  const remoteFailures: RemoteFailure[] = [];

  for (const entry of manifest.files) {
    if (entry.kind === 'shim') continue;
    const local = await readFile(join(vendorDir, entry.local), 'utf8');
    const localHash = sha256(local);

    if (options.write) {
      entry.sha256 = localHash;
    } else if (entry.sha256 !== localHash) {
      failures.push(`本地完整性失敗：${entry.local}（vendored 檔不得手改）`);
      continue;
    }

    if (!shouldCheckUpstream(options)) continue;
    const rawUrl = `https://raw.githubusercontent.com/${manifest.upstreamRepo.replace('https://github.com/', '')}/${manifest.upstreamBranch}/${entry.upstream}`;
    const remote = await fetchVendorText(fetchFn, rawUrl);
    if (!remote.ok) {
      remoteFailures.push(remote.failure);
      continue;
    }
    if (sha256(remote.text) !== localHash)
      failures.push(`上游漂移：${entry.local} 與 ${entry.upstream} 不一致`);
  }

  if (options.write) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log('MANIFEST sha256 已更新');
    return 0;
  }

  if (remoteFailures.length > 0) {
    const message = `${remoteFailures.length} 個檔案無法取得上游原檔\n${formatRemoteFailures(remoteFailures)}`;
    if (isCi) failures.push(`${message}\n（CI 環境視為失敗）`);
    else console.warn(`警告：${message}\n已跳過上游比對`);
  }

  if (failures.length > 0) {
    for (const line of failures) console.error(line);
    return 1;
  }
  console.log('vendored 檢查通過');
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runVendorCheck(process.argv.slice(2));
}
