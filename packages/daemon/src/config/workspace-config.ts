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
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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

/**
 * KAR-15.6 AC8 — writing `.DeFlow/config.yaml` back, for `PATCH /api/config`.
 *
 * Validated before it is written, by the caller, and written whole: this file
 * is small, hand-edited, and read by the packet builder on every node, so a
 * partial write that left it unparseable would take down every subsequent run
 * with a message about YAML rather than about configuration.
 *
 * Write, fsync, rename — docs/05-durable-execution.md §9.4 — with the temp file
 * a sibling of its target so the rename is atomic rather than a
 * cross-filesystem copy. An operator's `pinReinjectTurns` surviving a power cut
 * matters for the same reason KAR-09.4 guards the value at all: a setting the
 * operator believes is in force and is not is §13's highest-severity risk.
 */
export function writeWorkspaceConfig(cwd: string, config: unknown): void {
  const path = join(cwd, CONFIG_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });

  const temp = `${path}.DeFlow.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, Buffer.from(stringifyYaml(config), 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
