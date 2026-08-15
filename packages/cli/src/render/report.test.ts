/**
 * KAR-18.9 AC1, AC2, AC3, AC5 — the one presentation layer, read as output.
 *
 * [docs/12-frontend-architecture.md §9.2](../../../../docs/12-frontend-architecture.md)
 * — *"colour + glyph + text label, every time"* — is a WCAG 1.4.1 requirement
 * written for the UI, and a terminal is the easier place to get it wrong, not
 * the harder: colour disappears under a pipe, under `NO_COLOR` and on a dumb
 * terminal, so any meaning carried by colour alone is meaning that is routinely
 * absent. The specs below render with styling **on** and then strip every ANSI
 * sequence, which is the only way to prove that nothing was lost with it.
 *
 * Verifies: EPIC-18-S58, EPIC-18-S57 (its structural half) · AC1-AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { UTF8_GLYPHS } from './glyphs.ts';
import { REPORT_STATES, type Report, renderReport, STATE_LABELS } from './report.ts';
import { createStyle } from './style.ts';

const ESC = String.fromCharCode(27);
/**
 * Every ANSI sequence gone — what a pipe, `NO_COLOR` or a dumb TERM leaves.
 *
 * Built rather than written as a literal: an ESC inside a regular expression
 * literal is a control character in source, which both linters object to and
 * neither is wrong about.
 */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replaceAll(ANSI, '');

const styled = createStyle({ isTty: true, env: { TERM: 'xterm', LANG: 'en_US.UTF-8' } });
const plain = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });

suite('EPIC-18-S58 — every state survives having its colour removed (AC2)', () => {
  for (const state of REPORT_STATES) {
    it(`renders "${state}" as glyph, label and colour`, () => {
      const report: Report = {
        title: 'deflow doctor',
        sections: [{ title: 'Runtime', rows: [{ id: 'runtime.node', state, detail: 'a reason' }] }],
      };

      const rendered = renderReport(report, styled);
      expect(rendered).toContain(ESC);

      const stripped = stripAnsi(rendered);
      const line = stripped.split('\n').find((entry) => entry.includes('runtime.node'));
      expect(line).toBeDefined();
      // Glyph *and* label, with the colour gone: both survive the pipe.
      expect(line).toContain(UTF8_GLYPHS[state]);
      expect(line).toContain(STATE_LABELS[state]);
    });
  }

  it('gives the four states pairwise distinct glyphs and pairwise distinct labels', () => {
    const glyphs = REPORT_STATES.map((state) => UTF8_GLYPHS[state]);
    const labels = REPORT_STATES.map((state) => STATE_LABELS[state]);
    expect(new Set(glyphs).size).toBe(REPORT_STATES.length);
    expect(new Set(labels).size).toBe(REPORT_STATES.length);
  });

  it('distinguishes warn from fail without reading a single escape', () => {
    const report: Report = {
      title: 'deflow doctor',
      sections: [
        {
          title: 'Runtime',
          rows: [
            { id: 'a.warn', state: 'warn', detail: 'x' },
            { id: 'a.fail', state: 'fail', detail: 'x' },
          ],
        },
      ],
    };

    const lines = stripAnsi(renderReport(report, styled)).split('\n');
    const warn = lines.find((line) => line.includes('a.warn')) ?? '';
    const fail = lines.find((line) => line.includes('a.fail')) ?? '';
    expect(warn.replace('a.warn', '')).not.toBe(fail.replace('a.fail', ''));
  });
});

suite('sections are visually distinct from their contents (AC3)', () => {
  const report: Report = {
    title: 'deflow doctor',
    sections: [
      {
        title: 'Runtime',
        rows: [
          { id: 'runtime.node', state: 'ok', detail: 'Node 24.3.0' },
          { id: 'runtime.workspace-dir', state: 'ok', detail: 'writable' },
        ],
      },
      { title: 'git', rows: [{ id: 'git.version', state: 'ok', detail: 'git 2.51.0' }] },
    ],
  };

  it('puts a blank line before every heading and indents the checks under it', () => {
    const lines = renderReport(report, plain).split('\n');

    for (const title of ['Runtime', 'git']) {
      const index = lines.findIndex((line) => line.trimEnd() === title);
      expect(index).toBeGreaterThan(0);
      expect(lines[index - 1]).toBe('');
      expect(lines[index + 1]?.startsWith('  ')).toBe(true);
    }
  });

  it('aligns statuses on a width taken from the longest id in that section', () => {
    const lines = renderReport(report, plain).split('\n');
    const at = (id: string): number => (lines.find((line) => line.includes(id)) ?? '').indexOf('✓');

    // Both Runtime rows line up, on the longer of the two ids.
    expect(at('runtime.node')).toBe(at('runtime.workspace-dir'));
    expect(at('runtime.node')).toBe(2 + 'runtime.workspace-dir'.length + 2);
    // The git section computes its own, shorter, width — never a constant.
    expect(at('git.version')).toBe(2 + 'git.version'.length + 2);
    expect(at('git.version')).not.toBe(at('runtime.node'));
  });
});

suite('EPIC-18-S57 — the summary block (AC5)', () => {
  const failing: Report = {
    title: 'deflow doctor',
    exitCode: 5,
    sections: [
      {
        title: 'Runtime',
        rows: [
          { id: 'runtime.node', state: 'ok', detail: 'Node 24.3.0' },
          {
            id: 'runtime.state-dir',
            state: 'fail',
            detail: 'not writable',
            action: "chmod u+w ~/.local/share/DeFlow, then run 'deflow doctor' again",
          },
          { id: 'runtime.pnpm', state: 'warn', detail: 'absent', action: 'npm install -g pnpm' },
        ],
      },
    ],
  };

  it('ends the report with the summary, and starts the summary with the next action', () => {
    const lines = renderReport(failing, plain)
      .split('\n')
      .filter((line) => line !== '');
    const block = lines.slice(-2);

    // Last in the report, first within the block — KAR-18.9 AC5's settlement of
    // "at the end, ahead of the detail".
    expect(block[0]).toContain('next:');
    expect(block[0]).toContain("chmod u+w ~/.local/share/DeFlow, then run 'deflow doctor' again");
    expect(block.join('\n')).toContain('overall');
  });

  it('takes the next action from the worst check, not the first one', () => {
    // `runtime.pnpm` warns and comes last; `runtime.state-dir` fails. The fail
    // is what an operator has to act on.
    const summary = renderReport(failing, plain).split('\n').at(-2) ?? '';
    expect(renderReport(failing, plain)).toContain('chmod u+w');
    expect(summary).not.toContain('npm install -g pnpm');
  });

  it('reports the overall status, a count per state and the exit code', () => {
    const rendered = renderReport(failing, plain);
    expect(rendered).toContain('overall: ');
    expect(rendered).toContain('fail');
    expect(rendered).toContain('1 ok');
    expect(rendered).toContain('1 warn');
    expect(rendered).toContain('1 fail');
    expect(rendered).toContain('0 skipped');
    expect(rendered).toContain('exit 5');
  });

  it('names no next action when there is nothing to do', () => {
    const healthy: Report = {
      title: 'deflow doctor',
      exitCode: 0,
      sections: [{ title: 'Runtime', rows: [{ id: 'runtime.node', state: 'ok', detail: 'ok' }] }],
    };

    const rendered = renderReport(healthy, plain);
    expect(rendered).not.toContain('next:');
    expect(rendered).toContain('overall: ');
    expect(rendered).toContain('1 ok');
    expect(rendered).toContain('0 fail');
  });

  it('still names an action when the worst check carries none of its own', () => {
    const report: Report = {
      title: 'deflow status',
      fallbackAction: "run 'deflow doctor' for what this machine can do",
      sections: [{ title: 'Daemon', rows: [{ id: 'daemon', state: 'warn', detail: 'none' }] }],
    };
    expect(renderReport(report, plain)).toContain(
      "next: run 'deflow doctor' for what this machine can do",
    );
  });
});

suite('no line exceeds the width, whatever the detail is (AC4)', () => {
  it('keeps a 400-character detail inside a 60-column terminal', () => {
    const narrow = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' }, columns: 60 });
    const report: Report = {
      title: 'deflow doctor',
      sections: [
        {
          title: 'Sandboxing',
          rows: [
            {
              id: 'sandboxing.levels',
              state: 'warn',
              detail: 'word '.repeat(80).trim(),
            },
          ],
        },
      ],
    };

    for (const line of renderReport(report, narrow).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });
});
