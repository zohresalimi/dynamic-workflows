/**
 * `vue-tsc` resolves `.vue` imports as real modules, so it type-checks the SFCs
 * properly. Plain `tsc -b` — which the root solution file runs over every
 * package — cannot, and would fail with TS2307 on `./App.vue`. This ambient
 * wildcard is the fallback it uses; TypeScript prefers a real file resolution
 * over an ambient wildcard, so it never weakens what vue-tsc sees.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
