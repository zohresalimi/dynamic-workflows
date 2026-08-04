/**
 * KAR-00.2 needs two concrete Node binaries to run the spike matrix against —
 * major 24 (the pinned engine, `.node-version`) and major 26 (the newest
 * major, and the one where `--experimental-transform-types` was removed
 * outright, per D4). Resolution order: an explicit override env var, then the
 * highest matching version `nvm` has installed, then `node` on PATH if its
 * major already matches. Nothing here shells out to install a version — a
 * spike records what is actually on the machine, it does not provision one.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveNodeBinary(major: number): string {
  const override = process.env[`SPIKE_NODE_${major}_BIN`];
  if (override !== undefined && override !== '') return override;

  const nvmDir = process.env.NVM_DIR ?? join(homedir(), '.nvm');
  const versionsDir = join(nvmDir, 'versions/node');
  const fromNvm = highestInstalled(versionsDir, major);
  if (fromNvm !== undefined) return join(versionsDir, fromNvm, 'bin/node');

  const systemVersion = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim();
  if (systemVersion.startsWith(`v${major}.`)) return 'node';

  throw new Error(
    `no Node ${major} binary found. Install one (e.g. "nvm install ${major}") or set ` +
      `SPIKE_NODE_${major}_BIN to an absolute path.`,
  );
}

function highestInstalled(versionsDir: string, major: number): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return undefined;
  }
  const candidates = entries.filter((name) => name.startsWith(`v${major}.`));
  candidates.sort((a, b) => compareSemverDesc(a, b));
  return candidates[0];
}

function compareSemverDesc(a: string, b: string): number {
  const partsOf = (v: string) => v.slice(1).split('.').map(Number);
  const [aParts, bParts] = [partsOf(a), partsOf(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
