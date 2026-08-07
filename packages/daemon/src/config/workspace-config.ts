/**
 * KAR-09.4 AC5 — reading `.DeFlow/config.yaml`.
 *
 * The split is deliberate and follows docs/16-repo-layout.md R1: `@DeFlow/core`
 * owns the *shape* (`DeFlowConfigSchema`) and performs no I/O; this reads the
 * bytes. That is what lets the packet builder and the re-injection interval be
 * unit-tested against a value rather than against a temp directory, while the
 * two failures that only a real filesystem produces — an absent file and a file
 * in the wrong place — are still covered by an integration spec.
 *
 * **An absent file is an empty config, not an error.** Every value the file can
 * carry has a default, and a workspace that has never been configured is the
 * normal case rather than a misconfiguration.
 *
 * **A malformed file is an error that names the file.** A `pinReinjectTurns` of
 * `nope` silently falling back to 8 is a configuration the operator still
 * believes is in force, and this one guards the highest-severity risk in PRD
 * §13.
 */
import { type DeFlowConfig, parseDeFlowConfig } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Where the file lives, relative to the workspace root. */
export const CONFIG_RELATIVE_PATH = '.DeFlow/config.yaml';

/** The parsed config for the workspace rooted at `cwd`. */
export function loadWorkspaceConfig(cwd: string): DeFlowConfig {
  const path = join(cwd, CONFIG_RELATIVE_PATH);

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // ENOENT, and anything else that makes the file unreadable, mean the same
    // thing to a caller: nothing was configured here.
    return {};
  }

  try {
    return parseDeFlowConfig(parseYaml(text));
  } catch (error) {
    throw new Error(
      `${CONFIG_RELATIVE_PATH} at ${path} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
