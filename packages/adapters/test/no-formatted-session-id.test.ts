/**
 * KAR-19.8 AC1 — one producer of a vendor session id, and no call site that
 * formats one itself.
 *
 * The 2026-08-13 failure was three lines in `live-chain.ts` that each built an
 * identifier with a template literal — `` `${runId}-framing` `` — for a flag a
 * vendor validates. Nothing was wrong with the shim, the registry or the
 * parser; the value was simply chosen at the call site, where no test was
 * looking and no declared form applied.
 *
 * So the rule is mechanical rather than remembered: **no shipped source file
 * may build a session id out of string parts.** A `sessionId` is either derived
 * (`vendorSessionId`, `vendorSessionIdFor`) or passed through from something
 * that derived it. The scan is deliberately crude — it over-matches at worst,
 * which can only make it stricter — and it covers the two packages that spawn
 * vendor processes.
 *
 * Verifies: EPIC-19-S52 (the "asserted at source" clause) · KAR-19.8 AC1
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const ROOTS = [
  new URL('../src/', import.meta.url).pathname,
  new URL('../../daemon/src/', import.meta.url).pathname,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [path];
  });
}

/** Comments removed: prose may quote the value that broke, and this file's
 * own header does. */
function code(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const files = ROOTS.flatMap((root) => sourceFiles(root));

/**
 * A `sessionId` whose value is assembled here: a template literal, a
 * concatenation, or a bare string literal. A property shorthand
 * (`sessionId,`), an identifier (`sessionId: options.sessionId`) and a call
 * (`sessionId: vendorSessionId(...)`) are all fine — they name a value that
 * came from somewhere else.
 */
const FORMATTED = /\bsessionId\s*:\s*(`|'|"|[A-Za-z_$][\w$.]*\s*\+)/;

suite('KAR-19.8 AC1 — nothing formats a session id at a call site', () => {
  it.each(files.map((file) => [file.slice(file.indexOf('/packages/')), file] as const))(
    '%s builds no session id of its own',
    (_name, file) => {
      const matched = code(readFileSync(file, 'utf8')).match(FORMATTED);

      expect(matched?.[0] ?? null).toBeNull();
    },
  );

  it('scanned both packages that spawn a vendor process', () => {
    // A scan that silently found nothing is indistinguishable from a scan that
    // found nothing wrong — the failure mode this whole story is about.
    expect(files.length).toBeGreaterThan(40);
  });
});
