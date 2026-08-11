/**
 * KAR-18.4 — one status model, two printers.
 *
 * The failure this file exists to prevent is stated in EPIC-18-S36's note:
 * *"CI consumes the exit code, humans consume the text, and the fastest way to
 * get them out of step is to compute status in the renderer."* So the reducer
 * below is the only thing in the command that decides a status or an exit
 * code, and both renderers are asserted against the *same* reduced report
 * rather than against each other's prose.
 *
 * The empty-section case is the other half of AC1 (*"there is no silent or
 * empty section"*). A category that produced nothing is not a category that
 * passed, and the honest rendering of "this check did not run" is a `fail`
 * with a reason — not an omitted heading, which reads as green.
 *
 * Verifies: EPIC-18-S36, EPIC-18-S26 (AC1's no-empty-section half) · AC1,
 * AC10, AC11 · test plan #1, #11
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type CheckStatus,
  DOCTOR_EX_FAIL,
  DOCTOR_SECTION_IDS,
  type DoctorSectionInput,
  reduceReport,
  renderJson,
  renderText,
} from './report.ts';

/** A section carrying one check per requested status, with a real reason. */
function sectionOf(id: (typeof DOCTOR_SECTION_IDS)[number], statuses: readonly CheckStatus[]) {
  return {
    id,
    checks: statuses.map((status, index) => ({
      id: `${id}.${index}`,
      status,
      detail: `${status} because of reason ${index}`,
    })),
  } satisfies DoctorSectionInput;
}

/** Every section present, so only the `mix` under test decides the outcome. */
function reportOf(mix: readonly CheckStatus[]) {
  return reduceReport(
    DOCTOR_SECTION_IDS.map((id, index) =>
      sectionOf(id, index === 0 ? mix : (['ok'] as readonly CheckStatus[])),
    ),
  );
}

suite('the exit-code contract (EPIC-18-S36)', () => {
  const cases = [
    { mix: ['ok', 'ok'], status: 'ok', code: 0 },
    { mix: ['ok', 'warn'], status: 'warn', code: 0 },
    { mix: ['ok', 'warn', 'fail'], status: 'fail', code: DOCTOR_EX_FAIL },
    { mix: ['fail', 'fail'], status: 'fail', code: DOCTOR_EX_FAIL },
  ] as const;

  for (const { mix, status, code } of cases) {
    it(`reduces ${mix.join(' + ')} to ${status} and exit ${code}`, () => {
      const report = reportOf(mix);
      expect(report.status).toBe(status);
      expect(report.exitCode).toBe(code);
    });
  }

  it('has nothing but 0 and 5 in the contract', () => {
    for (const mix of [['ok'], ['warn'], ['fail']] as const) {
      expect([0, DOCTOR_EX_FAIL]).toContain(reportOf(mix).exitCode);
    }
  });
});

suite('both renderings agree (EPIC-18-S36)', () => {
  it('reports the same status for every check and the same exit code', () => {
    const report = reportOf(['ok', 'warn', 'fail']);
    const json = JSON.parse(renderJson(report)) as {
      status: string;
      exitCode: number;
      sections: { id: string; status: string; checks: { id: string; status: string }[] }[];
    };
    const text = renderText(report);

    expect(json.exitCode).toBe(report.exitCode);
    expect(json.status).toBe(report.status);

    for (const section of report.sections) {
      const rendered = json.sections.find((entry) => entry.id === section.id);
      expect(rendered?.status).toBe(section.status);
      expect(text).toContain(section.title);
      for (const check of section.checks) {
        expect(rendered?.checks.find((entry) => entry.id === check.id)?.status).toBe(check.status);
        // The text printer states the status verbatim, so a human reads the
        // same three words the machine document carries.
        expect(text).toContain(`${check.status}`);
        expect(text).toContain(check.detail);
      }
    }
  });

  it('emits one JSON document, not a stream of lines', () => {
    const rendered = renderJson(reportOf(['ok']));
    expect(() => JSON.parse(rendered) as unknown).not.toThrow();
    expect(rendered.trimEnd().split('\n').length).toBeGreaterThan(1);
  });
});

suite('no silent and no empty section (AC1)', () => {
  it('turns a section that produced nothing into a loud fail', () => {
    const report = reduceReport(
      DOCTOR_SECTION_IDS.map((id, index) =>
        index === 2 ? { id, checks: [] } : sectionOf(id, ['ok']),
      ),
    );

    const empty = report.sections[2];
    expect(empty?.checks).toHaveLength(1);
    expect(empty?.status).toBe('fail');
    expect(empty?.checks[0]?.detail).toContain('produced no checks');
    expect(report.exitCode).toBe(DOCTOR_EX_FAIL);
  });

  it('prints every section, in the documented order, with a reason on every check', () => {
    const report = reportOf(['ok']);
    expect(report.sections.map((section) => section.id)).toEqual([...DOCTOR_SECTION_IDS]);

    for (const section of report.sections) {
      expect(section.checks.length).toBeGreaterThan(0);
      for (const check of section.checks) {
        expect(['ok', 'warn', 'fail']).toContain(check.status);
        expect(check.detail).not.toBe('');
      }
    }
  });
});
