/**
 * Loads `.env` into `process.env`, in-process, before anything reads it.
 *
 * Node has a flag for this — `--env-file-if-exists=.env` — and it is what
 * docs/03-local-development.md §3 originally specified. It cannot be used here.
 *
 * **Verified 2026-08-04, Node 24.18.0:** a *relative* `--env-file-if-exists`
 * path combined with `--watch`/`--watch-path` makes the watcher react to writes
 * anywhere under the working directory. Vite's dependency optimizer writes a
 * fresh `node_modules/.vite/deps_temp_*` on every boot, so the daemon restarts,
 * Vite re-optimizes, and the loop restarts about twice a second forever. An
 * absolute path does not reproduce it; doing the work in-process avoids the
 * question entirely and is portable.
 *
 * This module is imported for its side effect by everything that reads
 * `process.env` at module scope, so the order it is loaded in cannot be broken
 * by an import sorter.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = process.env.DeFlow_ENV_FILE ?? resolve(process.cwd(), '.env');

let loaded = false;

export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(envFile)) return;
  process.loadEnvFile(envFile);
}

loadEnvFile();
