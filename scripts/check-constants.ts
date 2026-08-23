import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MESSAGE_RATE_LIMIT_PER_MIN,
  PEER_TIMEOUT_MS,
  RATE_LIMIT_PER_MIN,
  REGISTER_DEADLINE_MS,
  TURN_TOKEN_TTL_SEC,
} from '../core/constants';

export const SIGNALING_CONSTANT_NAMES = [
  'RATE_LIMIT_PER_MIN',
  'PEER_TIMEOUT_MS',
  'REGISTER_DEADLINE_MS',
  'MESSAGE_RATE_LIMIT_PER_MIN',
  'TURN_TOKEN_TTL_SEC',
] as const;

export type SignalingConstantName = (typeof SIGNALING_CONSTANT_NAMES)[number];
export type SignalingConstantValues = Readonly<Record<SignalingConstantName, number>>;

export interface SignalingConstantDrift {
  readonly kind: 'mismatch' | 'missing-documentation' | 'missing-implementation';
  readonly name: SignalingConstantName;
  readonly documented: number | undefined;
  readonly implemented: number | undefined;
}

const governedNames = new Set<string>(SIGNALING_CONSTANT_NAMES);

export function parseSignalingConstants(markdown: string): Partial<SignalingConstantValues> {
  const values: Partial<Record<SignalingConstantName, number>> = {};
  let inSignalingSection = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s+9(?:\.|\s)/.test(line)) {
      inSignalingSection = true;
      continue;
    }
    if (inSignalingSection && /^##\s+/.test(line)) break;
    if (!inSignalingSection) continue;

    const cells = line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
    const nameMatch = cells[0]?.match(/^`([A-Z][A-Z0-9_]*)`$/);
    if (!nameMatch || !governedNames.has(nameMatch[1]!)) continue;
    const rawValue = cells[1]?.replace(/[_,]/g, '');
    if (!rawValue || !/^\d+$/.test(rawValue)) continue;
    values[nameMatch[1] as SignalingConstantName] = Number(rawValue);
  }
  return values;
}

export function compareSignalingConstants(
  documented: Partial<SignalingConstantValues>,
  implemented: Partial<SignalingConstantValues>,
): SignalingConstantDrift[] {
  const drift: SignalingConstantDrift[] = [];
  for (const name of SIGNALING_CONSTANT_NAMES) {
    const documentValue = documented[name];
    const implementationValue = implemented[name];
    if (documentValue === undefined) {
      drift.push({
        kind: 'missing-documentation',
        name,
        documented: undefined,
        implemented: implementationValue,
      });
    } else if (implementationValue === undefined) {
      drift.push({
        kind: 'missing-implementation',
        name,
        documented: documentValue,
        implemented: undefined,
      });
    } else if (documentValue !== implementationValue) {
      drift.push({
        kind: 'mismatch',
        name,
        documented: documentValue,
        implemented: implementationValue,
      });
    }
  }
  return drift;
}

export interface RunConstantsCheckOptions {
  readonly specsDir?: string;
  readonly readFile?: (path: string) => string;
  readonly log?: (message: string) => void;
  readonly error?: (message: string) => void;
}

interface ParameterAuthoritiesManifest {
  readonly program: readonly string[];
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const implementedValues: SignalingConstantValues = {
  RATE_LIMIT_PER_MIN,
  PEER_TIMEOUT_MS,
  REGISTER_DEADLINE_MS,
  MESSAGE_RATE_LIMIT_PER_MIN,
  TURN_TOKEN_TTL_SEC,
};

export function runConstantsCheck(options: RunConstantsCheckOptions = {}): number {
  const specsDir = resolve(
    options.specsDir ?? process.env['O4_SPECS_DIR'] ?? resolve(repoRoot, '../open-4wd-specs'),
  );
  const manifestPath = resolve(specsDir, 'scripts/parameter-authorities.json');
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  let authorityPaths: readonly string[];
  let markdown: string;
  try {
    const manifest = JSON.parse(readFile(manifestPath)) as ParameterAuthoritiesManifest;
    if (
      !Array.isArray(manifest.program) ||
      manifest.program.length === 0 ||
      manifest.program.some(
        (entry) =>
          typeof entry !== 'string' || !entry.startsWith('程式參數/') || !entry.endsWith('.md'),
      ) ||
      new Set(manifest.program).size !== manifest.program.length
    ) {
      throw Object.assign(new Error('invalid program authority list'), { code: 'EINVAL' });
    }
    authorityPaths = manifest.program.map((entry) => resolve(specsDir, entry));
    markdown = authorityPaths.map((path) => readFile(path)).join('\n\n');
  } catch (caught) {
    const code =
      typeof caught === 'object' && caught !== null && 'code' in caught
        ? String(caught.code)
        : 'UNKNOWN';
    error(`check-constants: 無法讀取 Specs 程式參數 authority（${manifestPath}；${code}）`);
    return 1;
  }

  const documented = parseSignalingConstants(markdown);
  const drift = compareSignalingConstants(documented, implementedValues);
  const mismatches = drift.filter((item) => item.kind === 'mismatch');
  const coverageGaps = drift.filter((item) => item.kind !== 'mismatch');
  const matched = SIGNALING_CONSTANT_NAMES.length - drift.length;
  log(
    `check-constants: signaling authority ${authorityPaths.length} 檔、§9 一致 ${matched}/${SIGNALING_CONSTANT_NAMES.length}、值 drift ${mismatches.length}、覆蓋缺口 ${coverageGaps.length}`,
  );
  for (const item of coverageGaps) {
    log(
      `  （覆蓋缺口，不紅）${item.name}｜specs=${item.documented ?? 'missing'}｜signaling=${item.implemented ?? 'missing'}`,
    );
  }
  if (mismatches.length > 0) {
    error(`check-constants: ${mismatches.length} 筆值 drift：`);
    for (const item of mismatches) {
      error(
        `  ${item.name}｜specs=${item.documented ?? 'missing'}｜signaling=${item.implemented ?? 'missing'}`,
      );
    }
    return 1;
  }
  log('check-constants: OK（五項 owner-scoped 常數值無 drift）');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  process.exitCode = runConstantsCheck();
}
