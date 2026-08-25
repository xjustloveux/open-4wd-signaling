import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('public CI and release workflow contracts', () => {
  it('publishes the GitHub CI badge and links the repository license', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(
      '[![CI](https://github.com/xjustloveux/open-4wd-signaling/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/xjustloveux/open-4wd-signaling/actions/workflows/ci.yml)',
    );
    expect(readme).toContain('[MIT](LICENSE)');
    expect(readme).not.toContain('docs/badges/license-mit.svg');
  });

  it('only gives the Graphify release job write access for an official master push', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/graphify-release.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
    // 守門驗的是產出：release 自身的 immutable 欄位（現有 contents 權限即可讀），
    // 不得回頭查 repository 設定——administration 不在 GITHUB_TOKEN 的 permissions 之列。
    expect(workflow).toContain("--jq '.immutable'");
    expect(workflow).toContain('if [ "${immutable}" != "true" ]; then');
    expect(workflow).not.toContain('immutable-releases');
  });

  it('mints the specs token from the GitHub App Client ID without the legacy App ID input', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/graphify-release.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('client-id: ${{ vars.OPEN4WD_GRAPH_APP_CLIENT_ID }}');
    expect(workflow).not.toMatch(/^\s+app-id:/mu);
    expect(workflow).not.toContain('OPEN4WD_GRAPH_APP_ID');
  });

  it('replays the complete semantic cache through the tested Graphify runner', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/graphify-release.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('node scripts/run-graphify-release.mjs');
    expect(workflow).not.toMatch(/graphify extract[^\n]*(?:--code-only|--no-cluster)/u);
  });

  it('verifies vendored bytes self-contained until main is public', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    // 首次公開順序（specs 專案生命週期 §5）：signaling 先於 main 公開，public CI 不能依賴
    // 讀取 private main 的 remote raw；remote provenance gate 由 main 公開後另行啟用。
    expect(workflow).toContain('pnpm check:vendor -- --local-only');
    expect(workflow).not.toMatch(/pnpm check:vendor\s*$/mu);
    expect(workflow).not.toContain('secrets.');
  });

  it('smokes the built Docker image instead of only building it', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    // 映像建得出來不代表起得來：CI 必須真的 docker run 並跑與部署後相同的 smoke 腳本。
    const build = workflow.indexOf(
      'docker build -f deploy/docker/Dockerfile -t open4wd-signaling-ci .',
    );
    const run = workflow.indexOf(
      'docker run -d --name open4wd-signaling-smoke -p 8080:8080 open4wd-signaling-ci',
    );
    const smoke = workflow.indexOf('pnpm exec tsx scripts/smoke.ts ws://127.0.0.1:8080');
    expect(build).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(build);
    expect(smoke).toBeGreaterThan(run);
    expect(workflow).toContain('docker logs open4wd-signaling-smoke');
  });

  it('hard-fails signaling constant drift against an immutable public specs checkout', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toMatch(
      /repository:\s*xjustloveux\/open-4wd-specs[\s\S]*?ref:\s*[0-9a-f]{40}\s*(?:#.*)?\n[\s\S]*?path:\s*\.ci\/open-4wd-specs/u,
    );
    expect(workflow).toMatch(
      /run:\s*pnpm check:constants\s*\n\s*env:\s*\n\s*O4_SPECS_DIR:\s*\$\{\{ github\.workspace \}\}\/\.ci\/open-4wd-specs/u,
    );
    expect(workflow).not.toMatch(
      /repository:\s*xjustloveux\/open-4wd(?:-(?:pinning|signaling|turn))?(?:\s|$)/mu,
    );
  });

  it('is language-neutral, official-only, and independent of deploy workflows', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain("if: github.repository == 'xjustloveux/open-4wd-signaling'");
    expect(workflow).toContain('pnpm check:comments:self-test');
    expect(workflow).toContain('pnpm check:comments');
    expect(workflow).not.toContain('check:comment-language');
    expect(workflow).not.toContain('needs: comment-quality');

    const deploy = await readFile(
      new URL('../.github/workflows/deploy.yml', import.meta.url),
      'utf8',
    );
    expect(deploy).not.toContain('check:comments');
  });

  it('runs the node:test script contracts in the verify job for every fork', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    // node:test 檔被 vitest 排除，必須有自己的 CI 入口，且對 fork 也執行（不放 official-only job）。
    const verify = workflow.slice(0, workflow.indexOf('comment-quality:'));
    expect(verify).toContain('pnpm test:scripts');
    expect(pkg.scripts['test:scripts']).toBe(
      'node --test scripts/comment-hook-runner.test.mjs scripts/eslint-comment-quality.test.mjs scripts/issue-maintenance.test.mjs scripts/prepare-graphify-release.test.mjs scripts/run-graphify-release.test.mjs',
    );
  });

  it('reports specs lock drift weekly without blocking and without a floating checkout', async () => {
    const drift = await readFile(
      new URL('../.github/workflows/specs-lock-drift.yml', import.meta.url),
      'utf8',
    );
    // 只提醒不阻斷：排程＋手動、唯讀權限、specs 只 checkout 釘定 commit、比對範圍限本 repo 消費的路徑。
    expect(drift).toMatch(/^on:\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:/mu);
    expect(drift).toMatch(/^permissions:\n {2}contents: read$/mu);
    expect(drift).not.toMatch(/write/u);
    expect(drift).toContain('ref: ${{ steps.specs-lock.outputs.commit }}');
    expect(drift).not.toMatch(/ref:\s*(master|main)\b/u);
    // check-constants 會沿 manifest.program 再讀 程式參數/ 常數頁，drift 也必須涵蓋。
    expect(drift).toContain('-- scripts/parameter-authorities.json 程式參數)');
    expect(drift).toContain('::warning');
    expect(drift).not.toContain('exit 1');
  });

  it('declares the pnpm version once: packageManager is the single source and no workflow repeats it', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { packageManager?: string };
    const pinned = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager ?? '')?.[1];
    expect(pinned).toBeDefined();
    const workflowRoot = new URL('../.github/workflows/', import.meta.url);
    const names = (await readdir(workflowRoot)).filter((name) => name.endsWith('.yml'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const yaml = await readFile(new URL(name, workflowRoot), 'utf8');
      // pnpm/action-setup 同時看到 with.version 與 packageManager 且兩者不同時會直接中止
      // （Multiple versions of pnpm specified）；只接受「不帶 version」或「與 packageManager 完全相同」。
      for (const step of yaml.split(/\n(?=\s*- (?:uses|name|run):)/u)) {
        if (!step.includes('pnpm/action-setup')) continue;
        const version = /^\s*version:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(step)?.[1];
        expect(version === undefined || version === pinned, `${name}: ${step.trim()}`).toBe(true);
      }
    }
  });
});
