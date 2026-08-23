import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVendorOptions, runVendorCheck, shouldCheckUpstream } from './check-vendor';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('vendored checker mode', () => {
  it('local-only mode disables every upstream request while retaining write mode', () => {
    const options = parseVendorOptions(['--write', '--local-only']);
    expect(options).toEqual({ write: true, localOnly: true });
    expect(shouldCheckUpstream(options)).toBe(false);
  });

  it('default CI mode continues checking upstream drift', () => {
    const options = parseVendorOptions([]);
    expect(options).toEqual({ write: false, localOnly: false });
    expect(shouldCheckUpstream(options)).toBe(true);
  });

  it('CI reports HTTP status and URL without reading or printing the response body', async () => {
    vi.stubEnv('CI', 'true');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const text = vi.fn(async () => 'PRIVATE_RESPONSE_BODY');
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return { ok: false, status: 404, statusText: 'Not Found', url, text } as unknown as Response;
    });

    await expect(runVendorCheck([], fetchFn as typeof fetch)).resolves.toBe(1);

    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('HTTP 404');
    expect(output).toContain('raw.githubusercontent.com');
    expect(output).not.toContain('PRIVATE_RESPONSE_BODY');
    expect(text).not.toHaveBeenCalled();
  });

  it('non-CI reports safe network code and skips remote failures without leaking messages', async () => {
    vi.stubEnv('CI', 'false');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new TypeError('dns SECRET_AUTHORIZATION'), { code: 'ENOTFOUND' });
    });

    await expect(runVendorCheck([], fetchFn as typeof fetch)).resolves.toBe(0);

    const output = warn.mock.calls.flat().join('\n');
    expect(output).toContain('ENOTFOUND');
    expect(output).not.toContain('SECRET_AUTHORIZATION');
  });

  it('local-only mode performs zero upstream requests', async () => {
    const fetchFn = vi.fn();

    await expect(runVendorCheck(['--local-only'], fetchFn as typeof fetch)).resolves.toBe(0);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
