import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sha256,
  type VendorEntry as Entry,
  type VendorManifest as Manifest,
} from './vendor-manifest';

export interface SyncVendorOptions {
  readonly repoRoot: string;
  readonly upstreamRoot: string;
}

const canonicalPath = (path: string): string =>
  process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);

function relativeImports(source: Buffer): string[] {
  const imports: string[] = [];
  const pattern = /(?:from\s+|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of source.toString('utf8').matchAll(pattern)) {
    if (match[1] !== undefined) imports.push(match[1]);
  }
  return imports;
}

export async function syncVendor(
  options: SyncVendorOptions,
): Promise<{ copied: number; manifestPath: string }> {
  const vendorRoot = join(options.repoRoot, 'core', 'protocol', 'vendor');
  const manifestPath = join(vendorRoot, 'MANIFEST.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  const vendored = manifest.files.filter(
    (entry): entry is Entry & { upstream: string } =>
      entry.kind === 'vendored' && entry.upstream !== null,
  );
  const sources: { entry: Entry & { upstream: string }; bytes: Buffer }[] = [];
  const missing: string[] = [];

  for (const entry of vendored) {
    if (!entry.upstream.startsWith(manifest.upstreamSrcRoot)) {
      throw new Error(`上游路徑 ${entry.upstream} 不在宣告的 ${manifest.upstreamSrcRoot} 根目錄下`);
    }
    const relative = entry.upstream.slice(manifest.upstreamSrcRoot.length);
    try {
      sources.push({ entry, bytes: await readFile(join(options.upstreamRoot, relative)) });
    } catch {
      missing.push(entry.upstream);
    }
  }

  if (missing.length > 0) {
    throw new Error(`閉包缺檔：${missing.join(', ')}；中止同步且未寫入任何檔案`);
  }

  const manifestLocals = new Set(
    manifest.files.map((entry) => canonicalPath(resolve(vendorRoot, entry.local))),
  );
  const scanSources: { entry: Entry; bytes: Buffer }[] = [...sources];
  for (const entry of manifest.files) {
    if (entry.kind !== 'shim') continue;
    try {
      scanSources.push({ entry, bytes: await readFile(resolve(vendorRoot, entry.local)) });
    } catch {
      missing.push(entry.local);
    }
  }
  if (missing.length > 0) {
    throw new Error(`閉包缺檔：${missing.join(', ')}；中止同步且未寫入任何檔案`);
  }

  const missingImports: string[] = [];
  for (const source of scanSources) {
    const importer = resolve(vendorRoot, source.entry.local);
    for (const specifier of relativeImports(source.bytes)) {
      const target = resolve(dirname(importer), specifier);
      const candidates =
        extname(target) === '' ? [`${target}.ts`, join(target, 'index.ts')] : [target];
      if (!candidates.some((candidate) => manifestLocals.has(canonicalPath(candidate)))) {
        missingImports.push(`${source.entry.local} -> ${specifier}`);
      }
    }
  }
  if (missingImports.length > 0) {
    throw new Error(`匯入閉包缺檔：${missingImports.join(', ')}；中止同步且未寫入任何檔案`);
  }

  for (const source of sources) {
    const destination = join(vendorRoot, source.entry.local);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source.bytes);
    source.entry.sha256 = sha256(source.bytes);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { copied: sources.length, manifestPath };
}

const defaultRepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const upstreamRoot = resolve(
    defaultRepoRoot,
    process.env['OPEN4WD_UPSTREAM_ROOT'] ?? '../open-4wd/src',
  );
  try {
    const result = await syncVendor({ repoRoot: defaultRepoRoot, upstreamRoot });
    console.log(`${result.copied} files copied, MANIFEST written`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'vendor sync failed');
    process.exitCode = 1;
  }
}
