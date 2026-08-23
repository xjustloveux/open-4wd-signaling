import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_PEERS, TURN_TOKEN_TTL_SEC } from '../core/constants';
import { Network } from '../core/protocol/shim/system-constants';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function numericConst(relativePath: string, name: string): number {
  const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
  const match = source.match(new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^;]+);`));
  if (match === null) throw new Error(`numeric const not found: ${relativePath}#${name}`);
  const factors = match[1]!.split('*').map((value) => value.trim().replaceAll('_', ''));
  if (factors.some((value) => !/^\d+$/.test(value)))
    throw new Error(`unsupported numeric const: ${relativePath}#${name}`);
  return factors.reduce((product, value) => product * Number(value), 1);
}

describe('cross-file protocol limit tripwires', () => {
  it('keeps the room capacity equal in the core and vendored parser', () => {
    const parserMaxPeers = numericConst(
      'core/protocol/vendor/signaling-service/wire-parser.ts',
      'MAX_PEERS',
    );
    expect(MAX_PEERS).toBe(64);
    expect(parserMaxPeers).toBe(MAX_PEERS);
  });

  it('keeps Node WebSocket maxPayload equal to the vendored parser wire limit', () => {
    const nodeMaxMessageBytes = numericConst('adapters/node/server.ts', 'MAX_MESSAGE_BYTES');
    const parserMaxWireBytes = numericConst(
      'core/protocol/vendor/signaling-service/wire-parser.ts',
      'MAX_WIRE_BYTES',
    );
    expect(parserMaxWireBytes).toBe(256 * 1024);
    expect(nodeMaxMessageBytes).toBe(parserMaxWireBytes);
  });

  it('keeps the TURN credential TTL equal in core and the client shim', () => {
    expect(TURN_TOKEN_TTL_SEC).toBe(300);
    expect(Network.signaling.TURN_TOKEN_TTL_SEC).toBe(TURN_TOKEN_TTL_SEC);
  });

  it('keeps all three TURN request-body limits at 4 KiB', () => {
    const limits = [
      numericConst('adapters/node/server.ts', 'MAX_TURN_BODY_BYTES'),
      numericConst('adapters/worker/worker.ts', 'MAX_TURN_BODY_BYTES'),
      numericConst('adapters/worker/token-object.ts', 'MAX_BODY_BYTES'),
    ];
    expect(limits).toEqual([4_096, 4_096, 4_096]);
  });
});
