/**
 * KAR-12.6 test plan #1, #2, #7 (unit half) — the pure pieces of gate
 * discovery: hashing bytes, loading one source through the KAR-12.1 loader,
 * synthesising the built-ins, and the divergence comparison.
 *
 * Nothing here touches a filesystem. ../test/integration/gate-discovery.test.ts
 * is where a real `.DeFlow/gates/` directory and a real edited file live.
 *
 * Verifies: EPIC-12-S36, EPIC-12-S37 (outline) · AC1, AC2, AC4
 */
import type { GateId } from '@DeFlow/core';
import { createHash } from 'node:crypto';
import { expect, it, describe as suite } from 'vitest';
import { GateLoadError } from './definition.ts';
import {
  BUILTIN_GATE_SCRIPTS,
  builtinGateSources,
  checkGateDivergence,
  GATE_DEFINITION_DIVERGED,
  type GateManifestEntry,
  loadGateSource,
  sealDivergedVerdict,
  sha256Hex,
} from './discovery.ts';

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

const TYPECHECK_YAML = `id: typecheck
kind: deterministic
title: TypeScript project check
run: pnpm exec tsc -p tsconfig.json --noEmit
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-3, ac-7]
severityFloor: error
`;

suite('sha256Hex (test plan #4, the hash half)', () => {
  it('matches a hash computed directly over the same bytes', () => {
    const source = bytes(TYPECHECK_YAML);
    expect(sha256Hex(source)).toBe(createHash('sha256').update(source).digest('hex'));
  });

  it('is over bytes, not over the parsed object: a comment-only edit changes it', () => {
    const commented = bytes(`# temporarily loosen this\n${TYPECHECK_YAML}`);
    expect(sha256Hex(commented)).not.toBe(sha256Hex(bytes(TYPECHECK_YAML)));
  });
});

suite('loadGateSource (test plan #1)', () => {
  it('parses, validates and hashes a well-formed source', () => {
    const source = { path: '.DeFlow/gates/typecheck.yaml', bytes: bytes(TYPECHECK_YAML) };
    const discovered = loadGateSource(source);

    expect(discovered.id).toBe('typecheck');
    expect(discovered.path).toBe('.DeFlow/gates/typecheck.yaml');
    expect(discovered.sha256).toBe(sha256Hex(source.bytes));
    expect(discovered.definition.run).toBe('pnpm exec tsc -p tsconfig.json --noEmit');
  });

  it('throws GateLoadError, naming the file, for a bad source', () => {
    const source = {
      path: '.DeFlow/gates/a11y.yaml',
      bytes: bytes(TYPECHECK_YAML.replace('timeout: 300s', 'timeout: soon')),
    };
    try {
      loadGateSource(source);
      expect.unreachable('a bad definition must not load');
    } catch (error) {
      expect(error).toBeInstanceOf(GateLoadError);
      expect((error as GateLoadError).file).toBe('.DeFlow/gates/a11y.yaml');
    }
  });

  it('names the field and the line on a schema failure (AC2)', () => {
    const source = {
      path: '.DeFlow/gates/a11y.yaml',
      bytes: bytes(TYPECHECK_YAML.replace('timeout: 300s', 'timeout: soon')),
    };
    try {
      loadGateSource(source);
      expect.unreachable('a bad definition must not load');
    } catch (error) {
      const message = (error as GateLoadError).message;
      expect(message).toContain('timeout');
      expect(message).toMatch(/line \d+/);
    }
  });

  it('names the line of a syntactically invalid YAML file too', () => {
    const source = { path: '.DeFlow/gates/a11y.yaml', bytes: bytes('id: [unclosed\n') };
    try {
      loadGateSource(source);
      expect.unreachable('malformed YAML must not load');
    } catch (error) {
      expect((error as GateLoadError).message).toMatch(/line \d+/);
    }
  });
});

suite('builtinGateSources (S36, "built-ins appear with a path naming the recon source")', () => {
  it('lists exactly the well-known scripts a package.json actually declares', () => {
    const sources = builtinGateSources({ typecheck: 'tsc -b', format: 'biome format' });
    expect(sources.map((source) => source.path)).toEqual(['package.json#scripts.typecheck']);
  });

  it('produces a source that loads through the same door as a custom gate', () => {
    const [source] = builtinGateSources({ typecheck: 'tsc -b' });
    if (source === undefined) throw new Error('unreachable');
    const discovered = loadGateSource(source);
    expect(discovered.id).toBe('typecheck');
    expect(discovered.definition.effect).toBe('pure');
    expect(discovered.path).toBe('package.json#scripts.typecheck');
  });

  it('declares one source per BUILTIN_GATE_SCRIPTS entry that is present', () => {
    const scripts = Object.fromEntries(BUILTIN_GATE_SCRIPTS.map(({ script }) => [script, 'x']));
    expect(builtinGateSources(scripts)).toHaveLength(BUILTIN_GATE_SCRIPTS.length);
  });
});

suite('checkGateDivergence (S37 outline, the pure comparison)', () => {
  const entry: GateManifestEntry = {
    id: 'typecheck',
    path: '.DeFlow/gates/typecheck.yaml',
    sha256: sha256Hex(bytes(TYPECHECK_YAML)),
  };

  it('reports no divergence when the bytes still match', () => {
    const result = checkGateDivergence(entry, bytes(TYPECHECK_YAML));
    expect(result.diverged).toBe(false);
    expect(result.currentSha256).toBe(entry.sha256);
  });

  it('reports divergence, with both hashes, on an edit', () => {
    const edited = bytes(`${TYPECHECK_YAML}\n# loosened\n`);
    const result = checkGateDivergence(entry, edited);
    expect(result.diverged).toBe(true);
    expect(result.manifestSha256).toBe(entry.sha256);
    expect(result.currentSha256).toBe(sha256Hex(edited));
    expect(result.currentSha256).not.toBe(result.manifestSha256);
  });
});

suite('sealDivergedVerdict (S37)', () => {
  it('is needs-human, and the summary carries the reason and both hashes', () => {
    const verdict = sealDivergedVerdict({
      gate: 'typecheck' as GateId,
      node: 'gate-typecheck' as never,
      evaluatedNode: 'impl-1' as never,
      specHash: `sha256-${'a'.repeat(64)}`,
      criteria: ['ac-3'] as never,
      manifestSha256: 'aaa'.padEnd(64, '0'),
      currentSha256: 'bbb'.padEnd(64, '0'),
      durationMs: 0,
    });

    expect(verdict.outcome).toBe('needs-human');
    expect(verdict.summary).toContain(GATE_DEFINITION_DIVERGED);
    expect(verdict.summary).toContain('aaa'.padEnd(64, '0'));
    expect(verdict.summary).toContain('bbb'.padEnd(64, '0'));
    expect(verdict.findings).toEqual([]);
    expect(verdict.criteria).toEqual([{ id: 'ac-3', status: 'unverifiable' }]);
  });
});
