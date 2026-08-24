/**
 * One documented string, read as `(command, args)` — and nothing more
 * (docs/09-workspace-and-safety.md §10.4).
 *
 * This lived in `@DeFlow/gates` until KAR-23.9, where a second caller appeared:
 * a `tool` node's `run` line is judged by the same F5.6 deny list a gate's
 * `run:` line is, and the deny list lives here in `@DeFlow/core`. Two readings
 * of the same string would be two answers to "what binary is this", so the
 * reading moved down to the package both callers already depend on and
 * `@DeFlow/gates` re-exports it unchanged.
 *
 * **It is not a shell and it is not static analysis.** §10.4 is explicit that
 * analysing shell strings is undecidable and gives false confidence: there is
 * no expansion, no globbing, no substitution and no operator handling here. It
 * is the smallest reading that turns one field into the pair the permission
 * layer already judges. A command that needs a shell says so by naming one, and
 * is then judged as `sh` — which is the honest verdict, not a gap.
 */

/**
 * A command line as argv. Quote-aware, and deliberately nothing else.
 *
 * `a "b c" d` is three words; `$(echo rm)` is one word that names a binary
 * nobody allowlisted; `sh -c 'rm -rf /'` is `sh` with two arguments.
 */
export function splitCommandLine(line: string): readonly string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}
