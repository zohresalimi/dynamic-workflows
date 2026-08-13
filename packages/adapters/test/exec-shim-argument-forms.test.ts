/**
 * KAR-19.11 / EPIC-19-S71, EPIC-19-S72, EPIC-19-S73, EPIC-19-S75 — every
 * argument DeFlow puts on a vendor's command line has a declared form, and the
 * value it supplies matches it.
 *
 * **Two arguments in two days were found wrong by running the product.** On
 * 2026-08-13 at 19:57 Claude Code 2.1.220 refused `--session-id` because
 * DeFlow's own run id is not a UUID (KAR-19.8). At 19:59, one argument later,
 * the same binary refused
 *
 * ```
 * Error: --json-schema is not valid JSON: JSON Parse error: Unrecognized token '/'
 * ```
 *
 * because `shimInvocation` appended `[entry.structuredOutputFlag,
 * ctx.schemaPath]` for **every** vendor from one line, and Claude Code wants the
 * schema *document* where Codex CLI wants a *file*. The interesting number after
 * that is how many arguments are still wrong, and nothing in the repository
 * could answer it: the argv was asserted against fixtures and against doubles
 * that accepted whatever they were handed.
 *
 * So the guard is over the table. Its rows are derived from `PROVIDER_SPECS` ×
 * turn kind × permission level, and the form each value is checked against is
 * read from the entry's own declaration — a literal here would be a second copy
 * of the registry, and the vendor added next month would be covered by nobody.
 * An argument with no declared form **fails** rather than being skipped.
 *
 * Verifies: EPIC-19-S71 (the unit half), EPIC-19-S72, EPIC-19-S73, EPIC-19-S75 ·
 * KAR-19.11 AC1, AC2, AC3, AC4, AC8
 */
import { NodeIdSchema, type PermissionLevel, RunIdSchema } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  ARGUMENT_FORMS,
  ARGUMENT_PROVENANCE_KINDS,
  auditShimArgv,
  checkArgumentForm,
  MAX_ARGV_ELEMENT_BYTES,
  PROVIDER_SPECS,
  type ProviderSpec,
  type ShimContext,
  shimPlan,
  vendorSessionId,
} from '../src/index.ts';

const BIN = '/opt/DeFlow/bin';
const WORKTREE = '/tmp/DeFlow/wt/n1';
const RUN = RunIdSchema.parse('run_20260813T110608Z_379fc8');

const SCHEMAS_DIR = fileURLToPath(new URL('../../../schemas/', import.meta.url));

/** The document DeFlow would hand a turn, read from the emitted schema the
 * contract selects — never a hand-written stand-in, because the bytes are what
 * the vendor parses. */
const schemaDocumentOf = (schemaId: string): string =>
  readFileSync(join(SCHEMAS_DIR, `${schemaId}.json`), 'utf8');

const schemaPathOf = (schemaId: string): string => join(SCHEMAS_DIR, `${schemaId}.json`);

/** The document as claude's own validator accepts it: everything the emitter
 * wrote except the 2020-12 dialect declaration it cannot resolve. */
function withoutMetaSchema(document: string): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = JSON.parse(document) as Record<string, unknown>;
  return rest;
}

/**
 * EPIC-19-S71's Examples table: the four turn kinds that reach the shim, and
 * the contract each one carries.
 *
 * `framing`, `recon` and `planner` are the pre-execution turns
 * (`live-agents.ts`); `implement` stands for an agent node, which reaches the
 * same builder through `run-shim-node.ts`.
 */
const TURNS = [
  { turn: 'framing', schemaId: 'DeFlow.taskspecdraft.v1' },
  { turn: 'recon', schemaId: 'DeFlow.reconsurvey.v1' },
  { turn: 'planner', schemaId: 'DeFlow.plangraph.v1' },
  { turn: 'implement', schemaId: 'DeFlow.finding.v1' },
] as const;

const specs = Object.values(PROVIDER_SPECS) as readonly ProviderSpec[];

function context(spec: ProviderSpec, over: Partial<ShimContext> = {}): ShimContext {
  return {
    resolved: { provider: spec.id, path: `${BIN}/${spec.shim.bin}` },
    worktree: WORKTREE,
    prompt: 'summarise the failing test',
    sessionId: vendorSessionId({
      runId: RUN,
      nodeId: NodeIdSchema.parse('framing'),
      attempt: 0,
    }),
    permission: 'read',
    ...over,
  };
}

/** The value that follows `flag` in `argv`, or `null`. */
function valueOf(argv: readonly string[], flag: string): string | null {
  const at = argv.lastIndexOf(flag);
  return at < 0 ? null : (argv[at + 1] ?? null);
}

suite('KAR-19.11 AC1 — claude gets the schema document, on every turn that carries one', () => {
  const claude = PROVIDER_SPECS.claude;

  it.each(TURNS)('puts a parseable document on --json-schema for the $turn turn', (row) => {
    const document = schemaDocumentOf(row.schemaId);
    const argv = shimPlan(
      claude,
      context(claude, {
        schemaPath: schemaPathOf(row.schemaId),
        schemaDocument: document,
      }),
    ).argv;

    const value = valueOf(argv, '--json-schema');
    expect(value).not.toBeNull();

    // Parsed, never matched as a substring: the vendor's refusal was a
    // `JSON.parse` failure, so the assertion has to be the same operation. The
    // one key that differs is `$schema`, which this vendor's own validator
    // cannot resolve — declared as `stripKeys` on the entry and asserted below.
    expect(JSON.parse(value ?? '')).toEqual(withoutMetaSchema(document));

    // The '/' the vendor choked on: no element of the argv is the schema file's
    // path, on any turn.
    expect(argv).not.toContain(schemaPathOf(row.schemaId));
    for (const element of argv) expect(element).not.toMatch(/\.DeFlow\/schemas\//);
  });

  it('refuses to fall back to the path when the document was not supplied', () => {
    // The failure mode this replaces is silent: `shimInvocation` used to put
    // `ctx.schemaPath` on the flag for every vendor, which is the invocation
    // that died at 19:59. A caller that supplies only the path now learns so at
    // construction, before a process exists.
    expect(() =>
      shimPlan(claude, context(claude, { schemaPath: schemaPathOf('DeFlow.taskspecdraft.v1') })),
    ).toThrow(/--json-schema/);
  });
});

suite('KAR-19.11 AC2, AC3 — the shape of an argument is declared per entry', () => {
  it.each(specs.map((spec) => [spec.id, spec] as const))(
    '%s declares a form and a provenance for every argument it can emit',
    (_id, spec) => {
      expect(spec.shim.arguments.length).toBeGreaterThan(0);

      for (const argument of spec.shim.arguments) {
        expect(ARGUMENT_FORMS).toContain(argument.form);
        expect(ARGUMENT_PROVENANCE_KINDS).toContain(argument.provenance.how);
        // A date, so "verified" carries the day it was verified on. The
        // comment above `structuredOutputFlag` said **Verified 2026-08-02**
        // about a form nobody had ever run.
        expect(argument.provenance.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (argument.form === 'enum') expect(argument.values?.length).toBeGreaterThan(0);
      }
    },
  );

  it('declares every flag the entry advertises elsewhere on ShimSpec', () => {
    for (const spec of specs) {
      const declared = new Set(
        spec.shim.arguments.map((argument) => argument.flag).filter((flag) => flag !== null),
      );
      const advertised = [
        spec.shim.structuredOutputFlag,
        spec.shim.effortFlag,
        spec.shim.costCeilingFlag,
        spec.shim.secretEnvFlag,
        spec.shim.sandbox?.flag,
        spec.shim.sessionId?.flag,
      ].filter((flag): flag is string => flag !== undefined);

      for (const flag of advertised) {
        expect([spec.id, flag, declared.has(flag)]).toEqual([spec.id, flag, true]);
      }
    }
  });

  it('records provenance as three distinct claims, and the unexecuted set is the manual work list', () => {
    // EPIC-19-S72, third scenario. "Read from --help", "decoded from the
    // bundle" and "executed against the real binary" are not the same claim,
    // and writing them as though they were is how the 2026-08-02 note above
    // `structuredOutputFlag` came to read as verified.
    const unexecuted = specs.flatMap((spec) =>
      spec.shim.arguments
        .filter((argument) => argument.provenance.how !== 'executed')
        .map((argument) => `${spec.id}:${argument.name}`),
    );

    // The claim is not that the list is empty — it is that it is *written
    // down*. Two of the rows have been executed, and they are the two that
    // cost an operator their afternoon.
    const executed = specs.flatMap((spec) =>
      spec.shim.arguments
        .filter((argument) => argument.provenance.how === 'executed')
        .map((argument) => `${spec.id}:${argument.name}`),
    );

    expect(executed).toContain('claude:session-id');
    expect(executed).toContain('claude:json-schema');
    expect(unexecuted.length).toBeGreaterThan(0);
  });
});

suite('KAR-19.11 AC4 — the guard is over the table, and runs everywhere', () => {
  /** Every (entry, turn, permission, format) the table can express, derived
   * from the table rather than listed: a vendor added tomorrow is covered
   * without anyone remembering to cover it.
   *
   * The format axis is not decoration. It is what caught the audit's third
   * finding: OpenCode's flag is `--format default|json` and DeFlow's own
   * vocabulary spells the first of those `text`, so the builder used to pass a
   * value that vendor has no name for — the same class of defect as
   * `--json-schema`, one turn kind nobody had exercised. */
  const rows = specs.flatMap((spec) =>
    spec.shim.permissions.flatMap((permission) =>
      spec.shim.formats.flatMap((format) =>
        TURNS.map((turn) => ({ spec, permission, turn, format })),
      ),
    ),
  );

  it.each(
    rows.map(
      (row) => [`${row.spec.id}/${row.turn.turn}/${row.permission}/${row.format}`, row] as const,
    ),
  )('%s emits only arguments whose declared form its value matches', (label, row) => {
    const spec = row.spec;
    const permission: PermissionLevel = row.permission;
    const argv = shimPlan(
      spec,
      context(spec, {
        permission,
        format: row.format,
        sessionId: vendorSessionId({
          runId: RUN,
          nodeId: NodeIdSchema.parse(row.turn.turn),
          attempt: 0,
        }),
        ...(spec.shim.structuredOutputFlag === undefined
          ? {}
          : {
              schemaPath: schemaPathOf(row.turn.schemaId),
              schemaDocument: schemaDocumentOf(row.turn.schemaId),
            }),
        costCeilingUsd: 12.5,
      }),
    ).argv;

    const audit = auditShimArgv(spec, argv);
    expect(audit.length).toBeGreaterThan(0);

    // An element with no declared argument, or a value that does not match
    // the form its entry declares, is a failure naming the entry and the
    // token — never a skip.
    const problems = audit
      .filter((entry) => entry.argument === null || entry.problem !== null)
      .map((entry) => `${label}: ${entry.token ?? entry.value} — ${entry.problem ?? 'undeclared'}`);

    expect(problems).toEqual([]);
  });

  it('fails an entry that emits a value on a flag with no declared form', () => {
    const claude = PROVIDER_SPECS.claude;
    const audit = auditShimArgv(claude, ['--not-a-flag-this-entry-declares', 'x']);

    expect(audit[0]?.argument).toBeNull();
    expect(audit[0]?.problem).toMatch(/no declared form/i);
  });
});

suite('KAR-19.11 AC2 / EPIC-19-S73 — one contract, two argument shapes', () => {
  const schemaId = 'DeFlow.taskspecdraft.v1';

  it('sends the document to claude and the path to codex, from the same schema', () => {
    const document = schemaDocumentOf(schemaId);
    const path = schemaPathOf(schemaId);

    const claude = shimPlan(
      PROVIDER_SPECS.claude,
      context(PROVIDER_SPECS.claude, { schemaPath: path, schemaDocument: document }),
    ).argv;
    const codex = shimPlan(
      PROVIDER_SPECS.codex,
      context(PROVIDER_SPECS.codex, { schemaPath: path, schemaDocument: document }),
    ).argv;
    const mock = shimPlan(
      PROVIDER_SPECS.mock,
      context(PROVIDER_SPECS.mock, { schemaPath: path, schemaDocument: document }),
    ).argv;

    expect(JSON.parse(valueOf(claude, '--json-schema') ?? '')).toEqual(withoutMetaSchema(document));
    expect(valueOf(codex, '--output-schema')).toBe(path);
    expect(valueOf(mock, '--return-schema')).toBe(path);
  });

  it('reads the shape from the entry rather than from a vendor name in the code', () => {
    // The difference is one field of data. Whatever an entry declares is what
    // it gets, which is what stops the fix swinging the assumption the other
    // way and breaking the two entries that were right all along.
    for (const spec of specs) {
      const flag = spec.shim.structuredOutputFlag;
      if (flag === undefined) continue;
      const declared = spec.shim.arguments.find((argument) => argument.flag === flag);
      expect([spec.id, declared?.form]).toEqual([
        spec.id,
        spec.id === 'claude' ? 'inline-json' : 'abs-path',
      ]);
    }
  });
});

suite('KAR-19.11 AC8 / EPIC-19-S75 — a schema too big for the command line is refused', () => {
  const claude = PROVIDER_SPECS.claude;

  it('refuses at construction, naming the limit and the schema id', () => {
    const huge = JSON.stringify({
      title: 'DeFlow.taskspecdraft.v1',
      description: 'x'.repeat(MAX_ARGV_ELEMENT_BYTES + 1),
    });

    expect(() =>
      shimPlan(
        claude,
        context(claude, {
          schemaPath: schemaPathOf('DeFlow.taskspecdraft.v1'),
          schemaDocument: huge,
        }),
      ),
    ).toThrow(/DeFlow\.taskspecdraft\.v1/);

    expect(() =>
      shimPlan(
        claude,
        context(claude, {
          schemaPath: schemaPathOf('DeFlow.taskspecdraft.v1'),
          schemaDocument: huge,
        }),
      ),
    ).toThrow(new RegExp(String(MAX_ARGV_ELEMENT_BYTES)));
  });

  it('rides as exactly one argv element', () => {
    const document = schemaDocumentOf('DeFlow.taskspecdraft.v1');
    const argv = shimPlan(
      claude,
      context(claude, {
        schemaPath: schemaPathOf('DeFlow.taskspecdraft.v1'),
        schemaDocument: document,
      }),
    ).argv;

    const sent = JSON.stringify(withoutMetaSchema(document));
    expect(argv.filter((element) => element === sent)).toHaveLength(1);
  });

  it('drops only the dialect key the vendor cannot resolve, and only for its own copy', () => {
    // The audit's fourth finding, found by running the real binary once the
    // second was fixed: `Error: --json-schema is not a valid JSON Schema: no
    // schema with key or ref "https://json-schema.org/draft/2020-12/schema"`.
    const declared = claude.shim.arguments.find((one) => one.flag === '--json-schema');
    expect(declared?.stripKeys).toEqual(['$schema']);
    expect(declared?.provenance.how).toBe('executed');

    const document = schemaDocumentOf('DeFlow.taskspecdraft.v1');
    const argv = shimPlan(
      claude,
      context(claude, {
        schemaPath: schemaPathOf('DeFlow.taskspecdraft.v1'),
        schemaDocument: document,
      }),
    ).argv;
    const sent = JSON.parse(valueOf(argv, '--json-schema') ?? '') as Record<string, unknown>;

    expect(sent['$schema']).toBeUndefined();
    // Everything else survives — `$id`, `title` and the whole body, so the
    // contract the turn is held to is the one the file declares.
    expect(sent['$id']).toBe((JSON.parse(document) as Record<string, unknown>)['$id']);
    expect(sent['title']).toBe('DeFlow.taskspecdraft.v1');
    expect(sent['properties']).toEqual(
      (JSON.parse(document) as Record<string, unknown>)['properties'],
    );

    // The file on disk is untouched: NF8 is about what an operator can read
    // afterwards, and that is not what changed.
    expect(JSON.parse(schemaDocumentOf('DeFlow.taskspecdraft.v1'))['$schema']).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
  });
});

suite('KAR-19.11 — the closed vocabulary answers about values, not about names', () => {
  it('accepts and refuses each form for the reason it exists', () => {
    expect(checkArgumentForm({ form: 'inline-json' }, '{"a":1}')).toBeNull();
    expect(checkArgumentForm({ form: 'inline-json' }, '/tmp/x.json')).toMatch(/JSON/i);
    expect(checkArgumentForm({ form: 'abs-path' }, '/tmp/x.json')).toBeNull();
    expect(checkArgumentForm({ form: 'abs-path' }, '{"a":1}')).toMatch(/absolute/i);
    expect(checkArgumentForm({ form: 'uuid' }, '3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBeNull();
    expect(checkArgumentForm({ form: 'uuid' }, `${RUN}-framing`)).toMatch(/uuid/i);
    expect(checkArgumentForm({ form: 'enum', values: ['json'] }, 'json')).toBeNull();
    expect(checkArgumentForm({ form: 'enum', values: ['json'] }, 'yaml')).toMatch(/json/);
    expect(checkArgumentForm({ form: 'number' }, '12.5')).toBeNull();
    expect(checkArgumentForm({ form: 'number' }, 'NaN')).toMatch(/number/i);
    expect(checkArgumentForm({ form: 'free-text' }, 'anything at all')).toBeNull();
    expect(checkArgumentForm({ form: 'free-text' }, '')).toMatch(/empty/i);
  });
});
