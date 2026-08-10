/**
 * Mounting the real application in a browser spec.
 *
 * There is one assembly path (`../src/app/create-app.ts`) and this helper uses
 * it: a spec that built its own `createApp(App)` with a subset of the plugins
 * would be testing a shell that never ships, and the plugin that goes missing
 * is always the one the bug is in.
 *
 * Two substitutions, both narrow and both stated:
 *
 * - **Memory history**, because a browser history inside the runner's iframe
 *   rewrites the runner's own URL and the resulting failure reads as anything
 *   except "the spec navigated".
 * - **A token in `sessionStorage`**, because the shell gates every view behind
 *   one (AC3) and a spec about the keyboard map should not also be a spec about
 *   the handoff. Pass `{ anonymous: true }` to get the tokenless tab, which is
 *   what `../src/views/TokenRequired.test.ts` wants.
 */
import { createPinia, type Pinia, setActivePinia } from 'pinia';
import type { App as VueApp } from 'vue';
import { createMemoryHistory, type RouteLocationRaw, type Router } from 'vue-router';
import type { ApiClient } from '../src/api/client.ts';
import { provideApiClient } from '../src/api/provide.ts';
import { TOKEN_STORAGE_KEY } from '../src/api/token.ts';
import { createDeFlowApp } from '../src/app/create-app.ts';
import { type UiStore, useUiStore } from '../src/stores/useUiStore.ts';
import '../src/styles/theme.css';

/** A token shaped like a real one — base64url — and obviously not a real one. */
export const TEST_TOKEN = 'test-token-Aa0_-Bb1';

export interface MountedShell {
  readonly app: VueApp<Element>;
  readonly router: Router;
  readonly pinia: Pinia;
  readonly ui: UiStore;
  readonly container: HTMLElement;
  readonly unmount: () => void;
}

export interface MountOptions {
  /** Start with no token at all, the way a second tab does. */
  readonly anonymous?: boolean;
  /** Where to navigate before mounting. Defaults to the landing route. */
  readonly at?: RouteLocationRaw;
  /**
   * The API client the views resolve. Injected rather than monkey-patched
   * `fetch`, because what most of these specs assert is *which request the
   * client made*, and the typed client is the thing that decides that.
   */
  readonly client?: ApiClient;
}

/**
 * A UI store on a pinia of its own, for the specs that drive the store directly
 * rather than through a mounted app.
 */
export function freshUiStore(): UiStore {
  const pinia = createPinia();
  setActivePinia(pinia);
  return useUiStore(pinia);
}

export async function mountShell(options: MountOptions = {}): Promise<MountedShell> {
  if (options.anonymous === true) sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  else sessionStorage.setItem(TOKEN_STORAGE_KEY, TEST_TOKEN);

  const container = document.createElement('div');
  container.style.height = '480px';
  // Prepended rather than appended: the skip-link has to be the first focusable
  // element in the document for the tab-order assertion to mean anything.
  document.body.prepend(container);

  const { app, router, pinia } = createDeFlowApp(createMemoryHistory());
  setActivePinia(pinia);
  if (options.client !== undefined) provideApiClient(app, options.client);

  await router.push(options.at ?? '/');
  await router.isReady();
  app.mount(container);

  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    container.remove();
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  };

  return { app, router, pinia, ui: useUiStore(pinia), container, unmount };
}
