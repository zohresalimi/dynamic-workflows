/**
 * KAR-19.6 AC1 — *"no documented way to stop a run involves `curl` or a
 * hand-extracted bearer token, and a guard asserts the string `curl` appears in
 * no CLI help text, error message or docs page as a way to control a run."*
 *
 * On 2026-08-12 the only route to `POST /api/runs/:id/cancel` was `curl` with
 * the token read out of `daemon.json` by hand, because the CLI had no `cancel`
 * command. The fix is `deflow cancel`; this is what stops the workaround being
 * written down as the answer the next time a control verb ships without a
 * command in front of it. A capability an operator can only reach with a shell
 * one-liner and a copied secret is not a capability.
 *
 * The rule is narrow on purpose. `curl` is a legitimate word in this
 * repository: it is the example command in every permission-escalation
 * fixture, because "an agent wants to make a network request" is exactly what
 * F5.4 gates. What is banned is `curl` **in the same breath as controlling a
 * run** — the verbs, the control routes, and the token file.
 *
 * `docs/delivery/` is excluded and named rather than silently skipped: the
 * epics and flows quote the incident report verbatim, including the sentence
 * that says the only route was `curl`. A plan that may not describe the defect
 * it is fixing is a plan nobody can read.
 *
 * Verifies: EPIC-19-S37 · KAR-19.6 AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { allWorkspaceSources, docFiles, readSources } from './support/workspace.ts';

/** Words that make a line a line about controlling a run. */
const CONTROL = [
  'cancel',
  'pause',
  'resume',
  'abandon',
  '/api/runs',
  'daemon.json',
  'bearer',
  'Authorization',
];

interface Offence {
  readonly where: string;
  readonly line: string;
}

/** Every line naming `curl` **and** a way to control a run. */
function offences(files: readonly { path: string; text: string }[]): Offence[] {
  const found: Offence[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      if (!line.includes('curl')) return;
      const lower = line.toLowerCase();
      if (!CONTROL.some((word) => lower.includes(word.toLowerCase()))) return;
      found.push({ where: `${file.path}:${index + 1}`, line: line.trim() });
    });
  }
  return found;
}

/** The shipped tree plus every documentation page an operator is sent to. */
const pages = () =>
  readSources(docFiles().filter((path) => !path.startsWith('docs/delivery/'))).concat(
    readSources(['README.md']),
  );

const scanned = [...allWorkspaceSources(), ...pages()];

suite('AC1 — nobody is sent to curl to stop a run', () => {
  it('scans a tree that has both sources and documentation in it', () => {
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.map((file) => file.path)).toContain('packages/cli/src/cancel.ts');
    expect(scanned.some((file) => file.path.startsWith('docs/'))).toBe(true);
  });

  it('finds no line offering curl as a way to control a run', () => {
    expect(offences(scanned)).toEqual([]);
  });

  it('and that is a real result: the workaround itself is refused', () => {
    const workaround = [
      {
        path: 'docs/made-up.md',
        text:
          'To stop a run, read the token from .DeFlow/daemon.json and\n' +
          'curl -X POST http://127.0.0.1:7777/api/runs/$RUN/cancel\n',
      },
    ];
    expect(offences(workaround)).toHaveLength(1);
  });

  it('leaves the permission fixtures alone, which is why the rule is not "no curl"', () => {
    const egress = [
      { path: 'docs/made-up.md', text: 'the agent asks to run `curl https://example.com`\n' },
    ];
    expect(offences(egress)).toEqual([]);
  });
});
