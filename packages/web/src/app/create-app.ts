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
import { createPinia, type Pinia } from 'pinia';
import { createApp, type App as VueApp } from 'vue';
import type { Router, RouterHistory } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router/index.ts';

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

  return { app, router, pinia };
}
