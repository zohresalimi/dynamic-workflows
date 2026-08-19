/**
 * KAR-16.1 — the application, assembled once.
 *
 * `main.ts` calls this and mounts it; specs call it and mount it into a
 * container of their own. There is deliberately no second assembly path: a test
 * that built its own `createApp(App)` with a subset of the plugins would be
 * testing a shell that never ships, and the plugin that goes missing is always
 * the one the bug is in.
 *
 * Pinia and the router are the whole of it. `@vue/devtools-api` is installed as
 * a dependency but is not wired here — Pinia 4 stopped bundling it, and it
 * resolves it itself as long as it is present; installing it twice is how you
 * get two devtools panes.
 */
import { PiniaColada } from '@pinia/colada';
import { createPinia, type Pinia } from 'pinia';
import { createApp, type App as VueApp } from 'vue';
import type { Router, RouterHistory } from 'vue-router';
import App from '../App.vue';
import { useApiClient } from '../api/provide.ts';
import { createAppRouter } from '../router/index.ts';
import { createLegacyRunGuard } from '../router/legacy-run.ts';

export interface DeFlowApp {
  readonly app: VueApp<Element>;
  readonly router: Router;
  readonly pinia: Pinia;
}

export function createDeFlowApp(history?: RouterHistory): DeFlowApp {
  const app = createApp(App);
  const pinia = createPinia();
  const router = createAppRouter(history);

  app.use(pinia);
  app.use(router);
  // KAR-25.1 AC7 — the eight `legacy-*` run routes' shared guard.
  // `app.runWithContext` is what lets `useApiClient()` resolve the *same*
  // client this application was given (a spec's injected one, or the real
  // one) from inside a `router.beforeEach`, which runs with no component
  // instance of its own to `inject()` from otherwise. See
  // `../router/legacy-run.ts`'s header comment for the guard itself.
  router.beforeEach(createLegacyRunGuard(() => app.runWithContext(() => useApiClient())));
  // KAR-16.4 AC10 — the query half of the state split, and only that half.
  // Colada caches what changes because a *file on disk* changed
  // (`../api/queries.ts`); anything whose answer changes because an event was
  // appended is a projection in `../stores/useRunStore.ts` and must never
  // reach a fetch cache. `test/ui-foundation.test.ts` enforces the boundary.
  app.use(PiniaColada);

  // KAR-16.4 AC9 — the dev-only projection counter (docs/12 §5.4).
  //
  // **Both** modules are reached by a dynamic `import()` inside the DEV branch,
  // and each is load-bearing for a different reason.
  //
  // `./leak-assert.ts` is dynamic so that Vite — which substitutes `false` for
  // `import.meta.env.DEV` in a production build — eliminates the branch and
  // never puts the module in the graph at all: its `[proj]` tag is *absent*
  // from the bundle rather than merely unreachable in it. A static import with
  // a guarded call site would leave that up to tree-shaking noticing the only
  // use had gone, which ../../test/integration/dev-leak-assertion.test.ts would
  // then be asserting about the bundler rather than about this file.
  //
  // `../stores/useRunStore.ts` is dynamic for the *chunking*: it pulls
  // `../api/scrub.ts` and with it `@DeFlow/core`'s fold, which is a 150 KB
  // chunk the lazy plan-evolution route already owns. A static import here
  // would drag all of it into the initial chunk to satisfy a development
  // assertion — the exact regression `bundle-budget.test.ts` exists to catch.
  if (import.meta.env.DEV) {
    let stop: (() => void) | null = null;
    let torn = false;
    const unmount = app.unmount.bind(app);
    // An interval that outlives its store is itself a leak, and one this
    // counter would then be reporting on. The teardown has to cope with an
    // app unmounted before the dynamic import resolved, which is every short
    // browser spec in this package.
    app.unmount = () => {
      torn = true;
      stop?.();
      stop = null;
      unmount();
    };

    void import('./leak-assert.ts').then(async ({ startLeakAssertion }) => {
      const { useRunStore } = await import('../stores/useRunStore.ts');
      if (torn) return;
      const run = useRunStore(pinia);
      stop = startLeakAssertion({ counts: () => run.counts() });
    });
  }

  return { app, router, pinia };
}
