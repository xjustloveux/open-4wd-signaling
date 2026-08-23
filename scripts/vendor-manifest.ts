import { createHash } from 'node:crypto';

export interface VendorEntry {
  kind: 'vendored' | 'shim';
  local: string;
  upstream: string | null;
  sha256: string | null;
}

export interface VendorManifest {
  upstreamRepo: string;
  upstreamBranch: string;
  upstreamSrcRoot: string;
  files: VendorEntry[];
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
