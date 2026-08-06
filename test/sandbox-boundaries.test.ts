/**
 * KAR-08.5 — the three boundaries only a repository-wide grep can hold.
 *
 * Each one fails silently if it is ever crossed, and each one looks like a
 * small, reasonable edit in review:
 *
 *  - **AC1** — "DeFlow must not mutate the user's vendor CLI configuration" is
 *    an architectural rule (AR-1), and the way it gets broken is one plausible
 *    line that joins `homedir()` to `.claude`. A behavioural test can only
 *    cover the code paths somebody remembered to run; this covers the ones
 *    nobody did.
 *  - **AC7 / EPIC-08-S25 scenario 4** — a DeFlow-authored bubblewrap or
 *    Seatbelt profile "just to be safe" turns a working vendor sandbox into a
 *    broken one, and reads as extra diligence in a diff. The rule is that
 *    there are zero of them, anywhere, outside the pinned dependency.
 *  - **EPIC-08-S25 scenario 3** — `@anthropic-ai/sandbox-runtime` is 0.0.x.
 *    A caret would let its API change under a patch release nobody reviewed.
 *
 * The fourth suite is the chokepoint: `shimPlan` builds an invocation with no
 * sandbox policy on it, which is exactly right for KAR-05.8's argv goldens and
 * exactly wrong for a spawn. Production reaches it only through
 * `sandboxedShimPlan`.
 *
 * Verifies: EPIC-08-S20, EPIC-08-S25 · AC1, AC7 · test plan #4
 */
import { expect, it, describe as suite } from 'vitest';
// The module and not the package entry: root specs are not a workspace package
// and cannot resolve `@DeFlow/core` (the other root guards import the same way).
import {
  SANDBOX_RUNTIME_PACKAGE,
  SANDBOX_RUNTIME_VERSION,
} from '../packages/core/src/sandbox-policy.ts';
import type { SourceFile } from './support/guards.ts';
import {
  allWorkspaceSources,
  packageDirs,
  readJson,
  readText,
  readWorkspaceYaml,
} from './support/workspace.ts';

/** Comments quote `~/.claude` constantly — explaining the rule is how the next
 * reader understands it. Code is judged on its own. Over-removes at worst. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const sources: readonly SourceFile[] = allWorkspaceSources();

/**
 * The one file allowed to name a credential path: KAR-08.5's policy generator,
 * whose entire job is to hand that list to somebody else's enforcement engine.
 * Naming a path in a deny list is the opposite of opening it.
 */
const DENY_LIST_OWNER = 'packages/core/src/sandbox-policy.ts';

suite('no production source reaches into a user configuration directory (AC1)', () => {
  it('found sources to check at all', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  /**
   * The shapes a path into somebody's configuration takes in code. Each one is
   * a *construction*: a string literal that names the directory. Reading it
   * requires naming it first, which is what makes the grep sufficient.
   */
  const FORBIDDEN = [
    /['"`][^'"`]*\.claude\b/,
    /['"`][^'"`]*\.codex\b/,
    /['"`][^'"`]*\.config\/gh\b/,
    /['"`][^'"`]*\.aws\/credentials/,
    /['"`][^'"`]*\.ssh\b/,
    /['"`][^'"`]*Library\/Keychains/,
    /['"`][^'"`]*\.srt-settings\.json/,
  ];

  it('names no vendor config directory, no credential store and no wrapper default', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      if (file.path === DENY_LIST_OWNER) continue;
      const code = codeOnly(file.text);
      for (const pattern of FORBIDDEN) {
        if (pattern.test(code)) offenders.push(`${file.path} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the exempt file names them only to deny them', () => {
    // Guards the exemption: the deny list is data handed to a vendor, so the
    // file must not also be opening anything.
    const owner = sources.find((file) => file.path === DENY_LIST_OWNER);
    expect(owner, `${DENY_LIST_OWNER} is missing`).toBeDefined();

    const code = codeOnly(owner?.text ?? '');
    expect(code).toContain('~/.aws/credentials');
    expect(code).not.toMatch(/\breadFile|\bopen\(|\bwriteFile|node:fs/);
  });

  it('the guard would catch the mistake it exists for', () => {
    // A rule that has only ever seen a compliant repository is not known to
    // detect anything.
    const violating = codeOnly("const settings = join(homedir(), '.claude', 'settings.json');\n");
    expect(FORBIDDEN.some((pattern) => pattern.test(violating))).toBe(true);
  });
});

suite('no DeFlow-authored sandbox profile exists at all (AC7)', () => {
  /**
   * Authoring a profile, as opposed to talking about one. `bwrap`/`bubblewrap`
   * and `sandbox-exec` appear in prose all over this repository — the whole of
   * D12 is an argument about them — so what is banned is *invoking* them or
   * emitting profile syntax.
   */
  const AUTHORING = [
    /\bspawn\w*\(\s*['"`](?:bwrap|sandbox-exec)/,
    /['"`]--ro-bind\b/,
    /['"`]--unshare-\w+/,
    /\(version\s+1\)/,
    /\(allow\s+default\)/,
    /\(deny\s+file-write\*/,
  ];

  it('zero hits, outside the pinned dependency', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const code = codeOnly(file.text);
      for (const pattern of AUTHORING) {
        if (pattern.test(code)) offenders.push(`${file.path} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard would catch a hand-rolled bubblewrap invocation', () => {
    expect(AUTHORING.some((p) => p.test("spawn('bwrap', ['--ro-bind', '/', '/'])"))).toBe(true);
  });

  it('the guard would catch a hand-rolled Seatbelt profile', () => {
    expect(AUTHORING.some((p) => p.test('const profile = `(version 1)\\n(allow default)`;'))).toBe(
      true,
    );
  });
});

suite('sandbox-runtime is pinned exactly (EPIC-08-S25 scenario 3)', () => {
  it('the catalog holds the exact version, with no range operator', () => {
    const catalog = readWorkspaceYaml().catalog ?? {};
    expect(catalog[SANDBOX_RUNTIME_PACKAGE]).toBe(SANDBOX_RUNTIME_VERSION);
    expect(SANDBOX_RUNTIME_VERSION).not.toMatch(/^[\^~><=]/);
  });

  it('every package that depends on it consumes the catalog entry', () => {
    const consumers = packageDirs()
      .map((dir) => ({ dir, json: readJson(`${dir}/package.json`) }))
      .filter(({ json }) => json.dependencies?.[SANDBOX_RUNTIME_PACKAGE] !== undefined);

    expect(consumers.length).toBeGreaterThan(0);
    for (const { dir, json } of consumers) {
      expect(json.dependencies?.[SANDBOX_RUNTIME_PACKAGE], dir).toBe('catalog:');
    }
  });

  it('the reason it is pinned is written down next to the pin', () => {
    // A 0.0.x pin with no stated reason is one somebody bumps on sight. The
    // note has to be where the version is, not in a file nobody opens.
    const yaml = readText('pnpm-workspace.yaml');
    const entry = yaml.indexOf(SANDBOX_RUNTIME_PACKAGE);
    expect(entry).toBeGreaterThan(0);
    expect(yaml.slice(Math.max(0, entry - 600), entry)).toMatch(/0\.0\.x|unstable/i);
  });
});

suite('production spawns the sandboxed plan, never the bare one', () => {
  /** `shimPlan` with no policy applied is a KAR-05.8 golden-argv helper. The
   * one production caller is the function that adds the policy. */
  const ALLOWED = ['packages/adapters/src/sandbox.ts'];

  it('shimPlan( is called in exactly one production file', () => {
    // `(?<!function )` skips the declaration in provider-registry.ts: defining
    // it there is the point, and calling it anywhere else is the bug.
    const callers = sources
      .filter((file) => /(?<!function )\bshimPlan\(/.test(codeOnly(file.text)))
      .map((file) => file.path);

    expect(callers.toSorted()).toEqual(ALLOWED);
  });
});
