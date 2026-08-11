/**
 * KAR-16.6 AC10 — the one-line switch that swaps the renderer.
 *
 * `DeFlow_GRAPH_RENDERER=stub vite build` resolves every
 * `.../components/graph/GraphCanvas.vue` import to the stub renderer beside it.
 * Nothing else in the application changes, and that is the whole claim: the
 * facade's consumers name `GraphCanvas`, so replacing what `GraphCanvas` *is*
 * is a build-time alias rather than an edit anywhere.
 *
 * Both build configs use it — the SPA's (`../vite.config.ts`) and the
 * measurement harness's (`../measure/vite.config.ts`) — so the swap can be
 * proven twice over: the app still compiles, and a real 400-node plan still
 * renders through the node slot (`e2e/graph-facade-swap.test.ts`).
 *
 * In a normal build the variable is unset and this returns nothing at all, so
 * the stub is unreachable and never enters the bundle.
 */
import { fileURLToPath } from 'node:url';

export const RENDERER_ENV = 'DeFlow_GRAPH_RENDERER';

export interface AliasEntry {
  readonly find: RegExp;
  readonly replacement: string;
}

/** The alias list for the renderer named by `DeFlow_GRAPH_RENDERER`. */
export function graphRendererAlias(
  renderer: string | undefined = process.env[RENDERER_ENV],
): AliasEntry[] {
  if (renderer === undefined || renderer === '' || renderer === 'vue-flow') return [];
  if (renderer !== 'stub') {
    throw new Error(
      `${RENDERER_ENV}=${renderer} names no renderer this repository has. ` +
        'It is "stub" (packages/web/src/components/graph/GraphCanvas.stub.vue) or unset.',
    );
  }

  return [
    {
      // The pattern matches the **whole** id, not the file name inside it:
      // Vite substitutes only what the regex matched, so a pattern anchored on
      // the basename leaves the original directory glued to the front of an
      // absolute replacement and the build fails with a path that is half one
      // and half the other.
      find: /^.*[/\\]GraphCanvas\.vue$/,
      replacement: fileURLToPath(
        new URL('../src/components/graph/GraphCanvas.stub.vue', import.meta.url),
      ),
    },
  ];
}
