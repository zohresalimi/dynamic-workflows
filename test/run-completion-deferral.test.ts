/**
 * KAR-18.6 AC2 — the deferred half, recorded and given an expiry date.
 *
 * AC2 asks for _"a scripted multi-node run completes through `npx <tgz> run`
 * and exits 0"_. The completion half is not reachable in this repository and
 * is not faked: no shipped code path executes a submitted run past intake.
 * `POST /api/runs` stops at `task.submitted` by design (KAR-10.1, _"No
 * interpretation happens here"_). Since KAR-19.1 the run *is* framed —
 * `boot()` performs `start-ticker` and intake schedules the framing wake — and
 * since KAR-19.3 an approved spec is pinned, surveyed and compiled into a
 * `PlanGraph`. It still reaches no terminal state, because nothing shipped
 * calls `executeRun` over that plan. The same sentence is written into
 * `e2e/run.test.ts` for KAR-18.3.
 *
 * [README §9](../docs/delivery/README.md) is the rule this file enforces: **a
 * scope cut is recorded, never silently absorbed** — "note in the epic's Risks
 * or Out-of-scope section what is gone and where it now lives". Two prose
 * amendments are already in the plan; prose is what rots. This is the part a
 * suite can hold:
 *
 *   - **the record exists**, in the section README §9 names, pointing at the
 *     epic that owns the missing capability rather than at nothing;
 *   - **the record expires with its own premise.** The day a shipped source
 *     under any package's `src/` compiles a plan or executes a run, the reason
 *     AC2 was deferred has gone — and this file goes red, naming the two e2e
 *     specs whose deferral notes are then lies. It has already done this once:
 *     `startTicker` was a third premise until KAR-19.1 started the ticker, and
 *     the expiry was applied to the plan rather than to the assertion.
 *
 * A guard over the *absence* of a call site can only be trusted if it is shown
 * to bite, so every check here is a pure function over sources handed to it,
 * and every one has a spec that feeds it a violating source and watches it
 * catch it. That is the same shape as `test/no-gap-detection.test.ts`, and for
 * the same reason: a scan that has never failed is indistinguishable from a
 * scan that cannot.
 *
 * Verifies: EPIC-18-S42 · KAR-18.6 AC2 (its recorded-deferral half)
 */
import { expect, it, describe as suite } from 'vitest';
import { packageProductionSources, readText } from './support/workspace.ts';

interface Source {
  readonly path: string;
  readonly text: string;
}

const EPIC_FILE = 'docs/delivery/epics/EPIC-18-cli-packaging.md';

/**
 * The three functions that, called from a shipped source, would mean a
 * submitted run can now be driven to completion — each with the one file that
 * is allowed to contain its name followed by a paren, which is the file that
 * defines it.
 */
const DRIVERS: readonly (readonly [name: string, definedIn: string])[] = [
  // This list has been narrowed twice, and both times because **the guard did
  // its job**: it went red, and the deferral was narrowed in the epic file
  // rather than relaxed here (README §9).
  //
  //   - `startTicker` left on 2026-08-12, when KAR-19.1 wired `boot()` to
  //     `RECOVERY_STEPS`' eighth step;
  //   - `compilePlanV1` left on 2026-08-13, when KAR-19.3's run chain became
  //     its one shipped caller — a submitted run is now framed, gated, pinned,
  //     surveyed and **planned**.
  //
  // One premise is left, and it is the whole of what is still deferred: a run
  // with a compiled plan still reaches no terminal state, because nothing
  // shipped executes one. KAR-19.4 takes it, and KAR-19.5 deletes this file.
  ['executeRun', 'packages/daemon/src/exec/run-executor.ts'],
];

/**
 * The rule is about call sites, not about prose.
 *
 * Every file that explains why the run driver is not wired up has to write the
 * names down to explain it — this one included — and a comment naming
 * `executeRun` is not a daemon that runs anything.
 */
function code(source: Source): Source {
  return {
    ...source,
    text: source.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
  };
}

/** Every shipped call site of a run driver, outside the file that defines it. */
function driverCallSites(sources: readonly Source[]): string[] {
  const found: string[] = [];
  for (const source of sources.map(code)) {
    for (const [name, definedIn] of DRIVERS) {
      if (source.path === definedIn) continue;
      if (new RegExp(`\\b${name}\\s*\\(`).test(source.text)) found.push(`${source.path}: ${name}(`);
    }
  }
  return found.sort();
}

/** The `**Out of scope:**` list of an epic file, as one block of markdown. */
function outOfScope(epic: string): string {
  const start = epic.indexOf('**Out of scope:**');
  if (start === -1) return '';
  const end = epic.indexOf('\n## ', start);
  return epic.slice(start, end === -1 ? undefined : end);
}

/**
 * What README §9 asks of a cut: it is written down where a reader looking for
 * what this epic does *not* do would find it, it says which criterion was cut,
 * and it names where the work now lives rather than leaving it homeless.
 */
function checkDeferralRecorded(epic: string): string[] {
  const section = outOfScope(epic);
  if (section === '') return ['the epic file has no "**Out of scope:**" section'];

  const bullet = section
    .split(/\n(?=- )/)
    .find((entry) => entry.includes('AC2') && entry.includes('KAR-18.6'));
  if (bullet === undefined) {
    return [
      'no "Out of scope" bullet names KAR-18.6 AC2, so the cut is absorbed rather than recorded',
    ];
  }

  const problems: string[] = [];
  if (!/EPIC-\d\d/.test(bullet))
    problems.push('the bullet names no epic the deferred half lives in');
  if (!bullet.includes('start-ticker')) {
    problems.push('the bullet does not name `start-ticker`, the step whose absence is the reason');
  }
  return problems;
}

suite('KAR-18.6 AC2 — the cut is recorded where README §9 says cuts are recorded', () => {
  it('names the criterion and the epic the completion half now lives in', () => {
    expect(checkDeferralRecorded(readText(EPIC_FILE))).toEqual([]);
  });

  it('keeps the amendment on the criterion itself, next to what shipped instead', () => {
    // The Out-of-scope bullet is the index entry; this is the reasoning, and
    // README §9's "recorded, never silently absorbed" wants both. It must say
    // what is not met and refuse to claim otherwise.
    const epic = readText(EPIC_FILE);
    const amendment = epic.slice(
      epic.indexOf('> **Amended 2026-08-12 while implementing KAR-18.6.**'),
    );
    expect(amendment.startsWith('> **Amended')).toBe(true);
    expect(amendment).toContain('not reachable');
    expect(amendment).toContain('is not faked');
  });

  it('catches an epic file that quietly dropped the bullet', () => {
    const silent = [
      '## Scope',
      '',
      '**Out of scope:**',
      '',
      '- **Windows.** NF5 puts it at M3.',
      '',
      '## Definition of Ready',
    ].join('\n');
    expect(checkDeferralRecorded(silent)).toEqual([
      'no "Out of scope" bullet names KAR-18.6 AC2, so the cut is absorbed rather than recorded',
    ]);
  });

  it('catches a bullet that records the cut without saying where it went', () => {
    const homeless = [
      '**Out of scope:**',
      '',
      '- **Completing a submitted run.** KAR-18.6 AC2 is not met and we will get to it.',
      '',
      '## Definition of Ready',
    ].join('\n');
    expect(checkDeferralRecorded(homeless)).toHaveLength(2);
  });
});

suite('KAR-18.6 AC2 — the deferral expires with its premise', () => {
  it('holds only while nothing shipped drives a submitted run', () => {
    // When this fails, the deferral has outlived its reason. Do not relax it:
    // re-assert the completion half in `e2e/install-verification.test.ts`
    // (AC2, "completes … and exits 0") and in `e2e/run.test.ts` (EPIC-18-S18's
    // four-node plan), strike the two amendments and the Out-of-scope bullet
    // this file guards, and delete this suite — which is KAR-19.5 AC8, and is
    // what happened to `startTicker` on 2026-08-12 and to `compilePlanV1` on
    // 2026-08-13 (see DRIVERS above).
    expect(driverCallSites(packageProductionSources())).toEqual([]);
  });

  it('bites when a shipped source executes a run', () => {
    const wired: Source = {
      path: 'packages/daemon/src/services/supervisor.ts',
      text: 'await executeRun(ports);\n',
    };
    expect(driverCallSites([wired])).toEqual([
      'packages/daemon/src/services/supervisor.ts: executeRun(',
    ]);
  });

  it('ignores the definitions themselves, and the prose that explains them', () => {
    const definition: Source = {
      path: 'packages/daemon/src/exec/run-executor.ts',
      text: 'export async function executeRun(ports: RunPorts): Promise<void> {}',
    };
    const prose: Source = {
      path: 'packages/daemon/src/boot.ts',
      text: '// Nothing here calls executeRun(...) yet — the daemon has no run driver.\n',
    };
    expect(driverCallSites([definition, prose])).toEqual([]);
  });
});
