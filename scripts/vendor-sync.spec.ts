import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncVendor } from './vendor-sync';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function fixture() {
  const root = join(tmpdir(), `open4wd-signaling-vendor-${randomUUID()}`);
  const repoRoot = join(root, 'signaling');
  const upstreamRoot = join(root, 'main-src');
  const vendorRoot = join(repoRoot, 'core', 'protocol', 'vendor');
  const manifestPath = join(vendorRoot, 'MANIFEST.json');
  await mkdir(join(vendorRoot, 'signaling-service'), { recursive: true });
  await mkdir(join(upstreamRoot, 'signaling-service'), { recursive: true });
  const manifest = {
    upstreamRepo: 'https://github.com/xjustloveux/open-4wd',
    upstreamBranch: 'master',
    upstreamSrcRoot: 'src/',
    files: [
      {
        kind: 'vendored',
        local: 'signaling-service/first.ts',
        upstream: 'src/signaling-service/first.ts',
        sha256: sha256('old first'),
      },
      {
        kind: 'vendored',
        local: 'signaling-service/second.ts',
        upstream: 'src/signaling-service/second.ts',
        sha256: sha256('old second'),
      },
      {
        kind: 'shim',
        local: 'signaling-service/local-shim.ts',
        upstream: null,
        sha256: null,
      },
    ],
  } as const;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(vendorRoot, 'signaling-service', 'first.ts'), 'old first');
  await writeFile(join(vendorRoot, 'signaling-service', 'second.ts'), 'old second');
  await writeFile(join(vendorRoot, 'signaling-service', 'local-shim.ts'), 'local shim');
  return { repoRoot, upstreamRoot, vendorRoot, manifestPath };
}

describe('signaling vendor sync', () => {
  it('rejects an undeclared relative import before mutating targets or MANIFEST', async () => {
    const paths = await fixture();
    await writeFile(
      join(paths.upstreamRoot, 'signaling-service', 'first.ts'),
      "import './undeclared';\nexport const first = true;\n",
    );
    await writeFile(join(paths.upstreamRoot, 'signaling-service', 'second.ts'), 'new second\n');
    const beforeManifest = await readFile(paths.manifestPath);
    const beforeFirst = await readFile(join(paths.vendorRoot, 'signaling-service', 'first.ts'));

    let cause: unknown;
    try {
      await syncVendor(paths);
    } catch (error) {
      cause = error;
    }

    expect(await readFile(paths.manifestPath)).toEqual(beforeManifest);
    expect(await readFile(join(paths.vendorRoot, 'signaling-service', 'first.ts'))).toEqual(
      beforeFirst,
    );
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(
      /匯入閉包缺檔.*signaling-service[/\\]first\.ts.*\.\/undeclared/,
    );
  });

  it('preflights every vendored source before mutating targets or MANIFEST', async () => {
    const paths = await fixture();
    await writeFile(join(paths.upstreamRoot, 'signaling-service', 'first.ts'), 'new first');
    const beforeManifest = await readFile(paths.manifestPath);
    const beforeFirst = await readFile(join(paths.vendorRoot, 'signaling-service', 'first.ts'));

    await expect(syncVendor(paths)).rejects.toThrow(/second\.ts/);

    expect(await readFile(paths.manifestPath)).toEqual(beforeManifest);
    expect(await readFile(join(paths.vendorRoot, 'signaling-service', 'first.ts'))).toEqual(
      beforeFirst,
    );
  });

  it('copies exact vendored bytes, updates their hashes, and leaves shims untouched', async () => {
    const paths = await fixture();
    await writeFile(
      join(paths.upstreamRoot, 'signaling-service', 'first.ts'),
      "import './second';\r\nnew first\r\n",
    );
    await writeFile(join(paths.upstreamRoot, 'signaling-service', 'second.ts'), 'new second\n');
    const beforeShim = await readFile(join(paths.vendorRoot, 'signaling-service', 'local-shim.ts'));

    await expect(syncVendor(paths)).resolves.toMatchObject({ copied: 2 });

    const first = await readFile(join(paths.vendorRoot, 'signaling-service', 'first.ts'));
    const second = await readFile(join(paths.vendorRoot, 'signaling-service', 'second.ts'));
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'));
    expect(first).toEqual(Buffer.from("import './second';\r\nnew first\r\n"));
    expect(second).toEqual(Buffer.from('new second\n'));
    expect(manifest.files[0].sha256).toBe(sha256(first));
    expect(manifest.files[1].sha256).toBe(sha256(second));
    expect(manifest.files[2]).toEqual({
      kind: 'shim',
      local: 'signaling-service/local-shim.ts',
      upstream: null,
      sha256: null,
    });
    expect(await readFile(join(paths.vendorRoot, 'signaling-service', 'local-shim.ts'))).toEqual(
      beforeShim,
    );
  });
});
