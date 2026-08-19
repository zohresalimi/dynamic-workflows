/**
 * KAR-25.5 AC7, EPIC-25-S37 — the composer overlay id is gone, not dangling.
 *
 * Verifies: EPIC-25-S37
 *
 * Modelled on `./no-workspace-word.test.ts`: the enforcing script is
 * `packages/web/scripts/check-overlay-ids.ts`, run by `pnpm lint`; this is the
 * same rule at the level that fails a suite, plus a planted-violation case
 * proving the rule is not vacuous, and a bare assertion that the real tree
 * exports no `COMPOSER_OVERLAY` at all.
 */
import { expect, it, describe as suite } from 'vitest';
import { stripComments, webSourceFiles } from '../packages/web/scripts/check-graph-facade.ts';
import {
  HOSTED_OVERLAY_IDS,
  overlayIdViolations,
} from '../packages/web/scripts/check-overlay-ids.ts';

const sources = webSourceFiles();

suite('AC7 — no component still opens an overlay nothing renders', () => {
  it('finds sources to check, so a passing rule is not a rule over nothing', () => {
    expect(sources.length).toBeGreaterThan(30);
  });

  it('names exactly the two overlays with a mounted host', () => {
    expect([...HOSTED_OVERLAY_IDS].toSorted()).toEqual(['inspector', 'jumper']);
  });

  it('finds no violation in the real tree', () => {
    const violations = overlayIdViolations(sources);
    expect(violations.map((one) => one.where)).toEqual([]);
  });

  it('would catch a call site that still opens the composer overlay', () => {
    const planted = overlayIdViolations([
      ...sources,
      {
        path: 'src/components/SneakyComposer.vue',
        text: "<script setup lang='ts'>\nui.openOverlay('composer');\n</script>\n",
      },
    ]);

    expect(planted.map((one) => one.where)).toEqual(['src/components/SneakyComposer.vue']);
  });

  it('would catch COMPOSER_OVERLAY being re-exported', () => {
    const planted = overlayIdViolations([
      ...sources,
      {
        path: 'src/app/sneaky-ids.ts',
        text: "export const COMPOSER_OVERLAY = 'composer';\n",
      },
    ]);

    expect(planted.map((one) => one.where)).toEqual(['src/app/sneaky-ids.ts']);
  });

  it('does not fire on the two real overlay hosts', () => {
    const planted = overlayIdViolations([
      {
        path: 'src/components/FineOverlay.vue',
        text: "<script setup lang='ts'>\nui.openOverlay('jumper');\nui.isOverlayOpen('inspector');\n</script>\n",
      },
    ]);

    expect(planted).toEqual([]);
  });

  it('exports no COMPOSER_OVERLAY anywhere in the real tree — read past comments', () => {
    // Comment-stripped, like the script itself: a docblock explaining the
    // removal (this file's own header, `RunComposer.vue`'s) is expected to
    // still say the word. What must be gone is the *export*.
    const named = sources.filter((file) =>
      /\bexport\s+const\s+COMPOSER_OVERLAY\b/.test(stripComments(file.text)),
    );
    expect(named.map((one) => one.path)).toEqual([]);
  });
});
