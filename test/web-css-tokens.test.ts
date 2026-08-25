/**
 * KAR-27.4 AC3 — a `var(--x)` naming a token the stylesheet does not declare is
 * a red test, not a screenshot somebody has to notice.
 *
 * Verifies: EPIC-27-S21
 *
 * The failure this exists to catch is silent by construction, which is what
 * makes it worth a guard. An undefined custom property does not warn, does not
 * throw and does not fall back to the property's initial value in any way a
 * reviewer sees: the declaration becomes invalid *at computed-value time*, so
 * `gap: var(--space-2)` on a flex row resolves to `normal` — zero — and the row
 * renders exactly as if the author had never written a gutter at all. On
 * 2026-08-25 that shipped as `framingattempt 1 of 3running 1m 24s…` on the one
 * strip whose job is to prove a run is alive.
 *
 * Comments are stripped before matching, as every guard in this repository
 * does, so an explanation of the rule is never a breach of it.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type ScannedFile,
  undefinedTokenViolations,
} from '../packages/web/scripts/check-css-vars.ts';
import { webSourceFiles } from '../packages/web/scripts/check-graph-facade.ts';

const file = (path: string, text: string): ScannedFile => ({ path, text });

suite('undefinedTokenViolations', () => {
  it('names the file, the line and the property it could not find', () => {
    const violations = undefinedTokenViolations([
      file('styles/theme.css', ':root {\n  --ink: #191a18;\n}\n'),
      file(
        'components/Strip.vue',
        '<style scoped>\n.strip {\n  gap: var(--space-2);\n}\n</style>\n',
      ),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('components/Strip.vue');
    expect(violations[0]?.line).toBe(3);
    expect(violations[0]?.token).toBe('--space-2');
    expect(violations[0]?.message).toContain('--space-2');
    expect(violations[0]?.message).toContain('components/Strip.vue');
  });

  it('accepts a token the stylesheet declares', () => {
    expect(
      undefinedTokenViolations([
        file('styles/theme.css', ':root {\n  --ink-muted: #5f5b54;\n}\n'),
        file('components/Strip.vue', '<style>\n.strip { color: var(--ink-muted); }\n</style>\n'),
      ]),
    ).toEqual([]);
  });

  it('accepts a token declared in the same file it is used in', () => {
    expect(
      undefinedTokenViolations([
        file(
          'components/Local.vue',
          '<style>\n.a { --own: 4px; }\n.b { gap: var(--own); }\n</style>\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('accepts a token a style binding sets, quoted as an object key', () => {
    expect(
      undefinedTokenViolations([
        file(
          'components/Pill.vue',
          '<template>\n  <span :style="{ \'--pill-colour\': colour }" />\n</template>\n' +
            '<style>\n.pill { background: var(--pill-colour); }\n</style>\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('accepts a reference that carries its own fallback', () => {
    expect(
      undefinedTokenViolations([
        file(
          'components/Dot.vue',
          '<style>\n.dot { background: var(--maybe, currentColor); }\n</style>\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('does not read a reference out of a comment', () => {
    expect(
      undefinedTokenViolations([
        file(
          'components/Doc.vue',
          '<style>\n/* once said gap: var(--space-2) */\n.a { color: red; }\n</style>\n',
        ),
      ]),
    ).toEqual([]);
  });
});

suite('the live web package', () => {
  it('references no custom property the stylesheet does not declare', () => {
    const violations = undefinedTokenViolations(webSourceFiles());

    expect(violations.map((violation) => violation.message)).toEqual([]);
  });
});
