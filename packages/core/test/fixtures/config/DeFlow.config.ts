/**
 * A representative repository's `DeFlow.config.ts`, as
 * docs/09-workspace-and-safety.md §10.3 describes it: the project's **actual
 * verbs**, not a taxonomy of safe commands.
 *
 * It is a fixture and it is also the shape the shipped loader will read, so
 * the allowlist table in ../../repo-allowlist.test.ts is asking a real
 * question — "does this config allow the things a run of this repository
 * actually does" — rather than restating a literal from the spec file.
 *
 * Nothing machine-local is in here: the verbs are a JavaScript/Python
 * repository's, the domains are public registries, and there is no path.
 */
import type { CommandsConfig } from '../../../src/permission.ts';

export const commands: CommandsConfig = {
  /** §10.3's list, plus the two binaries this repository's own scripts use. */
  allow: [
    'git',
    'pnpm',
    'npm',
    'node',
    'pytest',
    'make',
    'cargo',
    'go',
    'tsc',
    'eslint',
    'vitest',
    'python',
  ],
  /** The subset a `read`-level node may run: it may look, and that is all. */
  readOnly: ['git status', 'git log', 'git diff', 'ls', 'cat'],
  /** Consulted only at `worktree+net`. */
  allowDomains: ['registry.npmjs.org', 'pypi.org'],
};

export default { commands };
