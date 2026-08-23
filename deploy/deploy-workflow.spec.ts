import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

describe('operator deploy workflow', () => {
  it('is dispatch-only, opt-in gated and SHA-pinned', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*push:/mu);
    expect(workflow).toContain("vars.DEPLOY_ENABLED == 'true'");
    for (const use of workflow.matchAll(/uses:\s*([^\s#]+)/gu))
      expect(use[1]).toMatch(/@[0-9a-f]{40}$/u);
  });

  it('fails closed on Cloudflare credentials and injects runtime secrets before deploy', () => {
    for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'INTERNAL_HMAC_SECRET'])
      expect(workflow).toContain(key);
    expect(workflow).toContain('wrangler secret put INTERNAL_HMAC_SECRET');
    expect(workflow).toContain('wrangler secret put TURN_URLS');
    expect(workflow).toContain('TURN_SHARED_SECRET and TURN_URLS must be configured together');
    expect(workflow).toContain('INTERNAL_HMAC_SECRET must contain at least 32 characters');
    expect(workflow).toContain('Every TURN_URLS entry must be a non-empty turn: or turns: URL');
    const firstDeploy = workflow.indexOf('wrangler deploy');
    const firstSecret = workflow.indexOf('wrangler secret put INTERNAL_HMAC_SECRET');
    const finalDeploy = workflow.lastIndexOf('wrangler deploy');
    expect(firstDeploy).toBeLessThan(firstSecret);
    expect(finalDeploy).toBeGreaterThan(firstSecret);
  });
});
