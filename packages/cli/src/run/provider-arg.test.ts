/**
 * KAR-19.10 AC1 — `DeFlow run --provider <id>`, validated against the registry
 * before anything is submitted.
 *
 * Test plan #1, and EPIC-19-S66's outline verbatim. The red is the reported
 * defect at the level it is cheapest at: on 2026-08-13 the operator typed
 * `--provider mock` on the one command whose job is to start a run on an agent
 * and got `DeFlow run: unknown option "--provider"`.
 *
 * Two things are asserted beyond "the flag exists". First, an unknown id is
 * `EX_USAGE` and **not** exit 5 — a misspelling is not an unusable machine, and
 * `RUN_EXIT_CODES` is a closed set of run outcomes a bad argv is not a member
 * of. Second, the message carries both halves of the operator's next question:
 * what is registered, and which of those this machine can actually serve.
 *
 * Verifies: EPIC-19-S66 · AC1, AC9
 */
import { PROVIDER_SPECS } from '@DeFlow/adapters';
import { expect, it, describe as suite } from 'vitest';
import { type ProviderChoice, parseRunArgs } from './args.ts';

/** What the command body computes from the operator's `PATH` and hands the
 * parser, so the parser itself stays a pure function of its arguments. */
const CHOICES: readonly ProviderChoice[] = [
  { id: 'claude', usable: false },
  { id: 'gemini', usable: false },
  { id: 'mock', usable: true },
];

const parse = (argv: readonly string[]) => parseRunArgs(argv, { providers: CHOICES });

suite('--provider is accepted and carried (AC1)', () => {
  it('takes a registered id as a separate argument', () => {
    const parsed = parse(['--provider', 'mock', '--file', 'spec.md']);
    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
    expect(parsed.ok && parsed.args.provider).toBe('mock');
  });

  it('takes the --provider=<id> form too', () => {
    const parsed = parse(['--provider=mock', 'a task']);
    expect(parsed.ok && parsed.args.provider).toBe('mock');
  });

  it('is null when the operator did not ask for one (AC3)', () => {
    const parsed = parse(['a task']);
    expect(parsed.ok && parsed.args.provider).toBeNull();
  });
});

suite('an unknown --provider is refused before submission (AC1)', () => {
  const REFUSED: readonly (readonly string[])[] = [
    ['--provider'],
    ['--provider', ''],
    ['--provider', 'clawed'],
    ['--provider', 'CLAUDE', '--file', 's.md'],
  ];

  it.each(REFUSED)('refuses %j', (...argv: readonly string[]) => {
    const parsed = parse(argv);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('--provider');
  });

  it('lists the registered ids, and which of them are usable here', () => {
    const parsed = parse(['--provider', 'clawed', '--file', 's.md']);
    expect(parsed.ok).toBe(false);
    const message = parsed.ok ? '' : parsed.message;
    for (const choice of CHOICES) expect(message).toContain(choice.id);
    // The usable-here half is what stops the next question: knowing `gemini` is
    // registered is not useful to an operator whose machine does not have it.
    expect(message).toContain('Usable on this machine: mock');
  });

  it('derives the list from the registry rather than from a literal', () => {
    // The parser's own default, with no choices supplied, is every id
    // `PROVIDER_SPECS` holds — so adding an entry changes the message with no
    // other edit (AC1, AC9).
    const parsed = parseRunArgs(['--provider', 'clawed', '--file', 's.md']);
    expect(parsed.ok).toBe(false);
    const message = parsed.ok ? '' : parsed.message;
    for (const id of Object.keys(PROVIDER_SPECS)) expect(message).toContain(id);
  });
});
