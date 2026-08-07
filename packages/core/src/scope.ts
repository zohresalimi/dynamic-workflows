/**
 * The primitives the execution boundary is expressed in: a POSIX path against
 * a worktree root, a URL against a domain allowlist, an argv against a binary
 * name.
 *
 * Their own module because ./permission.ts (the ladder) and
 * ./destructive-command.ts (the cheap syntactic second layer) both need all
 * six, and the alternative shapes are worse: an import cycle between the two,
 * or a second copy of `resolvePosix` that agrees with the first until someone
 * fixes a bug in one of them. Every function here is total, pure, and free of
 * `node:` builtins — @DeFlow/core imports none (R1).
 */

/**
 * POSIX `path.resolve` semantics, without `node:path`.
 *
 * Windows is M3; the ACP methods carry POSIX-shaped absolute paths on the two
 * platforms M1 supports.
 */
export function resolvePosix(base: string, path: string): string {
  const raw = path.startsWith('/') ? path : `${base}/${path}`;
  const out: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * Whether `path` is the worktree root or something beneath it, lexically.
 *
 * Segment-wise rather than by string prefix, so `<tmp>/wt-other` is not inside
 * `<tmp>/wt`. **Lexical only** — a symlink inside the worktree pointing at
 * `/etc` satisfies this predicate, and KAR-08.2's mediator is what closes that
 * by feeding it a `realpath`-resolved path.
 */
export function pathIsInside(root: string, path: string): boolean {
  const base = resolvePosix('/', root);
  const target = resolvePosix(base, path);
  return target === base || target.startsWith(base === '/' ? '/' : `${base}/`);
}

/**
 * How many segments deep a path is once resolved: `/` is 0, `/usr` is 1,
 * `/usr/local` is 2.
 *
 * The `rm -r` rule in §10.4 is a **depth** rule, and the depth is of the
 * resolved path rather than of the string. `dist` is one segment written down
 * and four resolved against a worktree, and a rule that counted the string
 * would gate `rm -rf dist` — a verb every repository with a build step uses,
 * and therefore the fastest possible way to blow the §10.5 gate budget.
 */
export function pathDepth(base: string, path: string): number {
  const resolved = resolvePosix(base, path);
  return resolved === '/' ? 0 : resolved.split('/').length - 1;
}

/**
 * The binary the operator would recognise: `./node_modules/.bin/vitest` is
 * `vitest`. Allowlist matching is on this and never on the raw string, or the
 * repository's own tooling gates on every invocation and the gate budget
 * (§10.5) is blown by the second node.
 */
export function binaryName(command: string): string {
  const at = command.lastIndexOf('/');
  return at === -1 ? command : command.slice(at + 1);
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/** The host of a URL-shaped string, lowercased, port and userinfo removed, or
 * `null` when the string is not URL-shaped. Hand-rolled rather than `new URL`
 * because this must be total: an agent-supplied string that throws is a crash
 * on the safety path. */
export function hostOf(value: string): string | null {
  const match = URL_LIKE.exec(value);
  if (match === null) return null;
  const authority = (match[1] ?? '').slice((match[1] ?? '').lastIndexOf('@') + 1);
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return (end === -1 ? authority : authority.slice(0, end + 1)).toLowerCase();
  }
  const colon = authority.indexOf(':');
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
}

/** §10.5's rule is "reaches a **non-localhost** host". A dev server on
 * 127.0.0.1 is inside the boundary, and gating it would be exactly the run
 * with 200 gates that the frequency argument forbids. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '[::]']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || host.endsWith('.localhost');
}

/** A bare domain matches itself and any subdomain of it. */
export function domainAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((domain) => {
    const entry = domain.toLowerCase();
    return host === entry || host.endsWith(`.${entry}`);
  });
}
