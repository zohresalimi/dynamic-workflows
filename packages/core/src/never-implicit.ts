/**
 * The never-implicit environment families (docs/15-security-model.md §4.1),
 * stated once.
 *
 * Two layers need the same answer to "is this name a secret?" and they are in
 * different packages, which is why the list lives here rather than beside
 * either of them:
 *
 *  - `buildChildEnv()` (KAR-08.4, `@DeFlow/daemon`) drops a matching variable
 *    from the agent's environment altogether;
 *  - `claudeSandboxPolicy()` (KAR-08.5, ./sandbox-policy.ts) hands the same
 *    families to the *vendor's* credential layer, so that a value the agent
 *    obtains some other way is still masked at the enforcement point DeFlow
 *    does not own.
 *
 * A second copy of the list is the failure mode worth designing against: the
 * two layers would drift, and the drift would be invisible — the scrubbed
 * layer would keep working and the delegated one would quietly stop covering
 * a family somebody added on the other side.
 *
 * **A family, not a name.** `MY_CUSTOM_TOKEN` and `x_api_key` are both secrets
 * and neither is on any list anybody would think to write. The entries below
 * are therefore glob families — a `*` at one end or the other — matched
 * case-insensitively, and they generalise to the secret a future integration
 * adds.
 */

/**
 * §4.1's families, in the order the document lists them.
 *
 * The glob spelling is not decoration: it is also what goes on the wire to a
 * vendor's credential deny list, so the same string is both the predicate
 * below and the value in ./sandbox-policy.ts's generated policy.
 */
export const NEVER_IMPLICIT_FAMILIES = [
  'AWS_*',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_*',
  'KUBECONFIG',
  'DATABASE_*',
  'TF_*',
  'TERRAFORM_*',
  'VAULT_*',
  'DOCKER_*',
  'REGISTRY_*',
  'SSH_AUTH_SOCK',
  '*_TOKEN',
  '*_API_KEY',
  '*_SECRET',
  '*_PASSWORD',
  '*_CREDENTIALS',
] as const;

export type NeverImplicitFamily = (typeof NEVER_IMPLICIT_FAMILIES)[number];

/**
 * One family as a matcher.
 *
 * Only a leading or trailing `*` is meaningful — every family §4.1 names is a
 * prefix, a suffix or an exact name — so anything else in the string is
 * matched literally rather than interpreted, which keeps a typo from silently
 * widening or narrowing a family.
 */
function matcher(family: string): (name: string) => boolean {
  const lower = family.toLowerCase();
  if (lower.startsWith('*')) {
    const suffix = lower.slice(1);
    return (name) => name.toLowerCase().endsWith(suffix);
  }
  if (lower.endsWith('*')) {
    const prefix = lower.slice(0, -1);
    return (name) => name.toLowerCase().startsWith(prefix);
  }
  return (name) => name.toLowerCase() === lower;
}

const MATCHERS = NEVER_IMPLICIT_FAMILIES.map(matcher);

/**
 * Whether `name` belongs to one of §4.1's never-implicit families.
 *
 * Case-insensitive, because `x_api_key` is exactly as much a secret as
 * `X_API_KEY` and an exact-name list catches neither of the two.
 */
export function isNeverImplicit(name: string): boolean {
  return MATCHERS.some((matches) => matches(name));
}
