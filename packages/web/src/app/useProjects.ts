/**
 * KAR-26.5 (audit item: "Breadcrumb, project segment") — the one
 * `GET /api/projects` read the frame makes, held where both of its readers can
 * reach it.
 *
 * `ProjectSwitcher.vue` has always owned this request ("it adds no request the
 * application did not already make" — its own docblock), and `AppTopBar.vue`
 * has always refused to add a second one to resolve a project id into its
 * display name — which left the breadcrumb rendering the raw id. The audit
 * closes that gap without moving either principle: the rows live here, in one
 * handle provided at the application root, the switcher still triggers the one
 * fetch, and the topbar only *reads* the answer.
 *
 * **Provide/inject rather than a module singleton or a WeakMap keyed by
 * client**, for a reason that only shows in production: `useApiClient()`
 * falls back to building a fresh client per call when none was provided
 * (`../api/provide.ts`), so any cache keyed by the client object would give
 * the switcher and the topbar two different entries in exactly the deployment
 * that matters. An app-level `provide` is scoped to the one application the
 * way `API_CLIENT` itself is, and a spec that mounts two shells gets two
 * handles by construction.
 *
 * **Not a Pinia store**, for the reason `ProjectsView.vue`'s docblock gives:
 * this list has no stream topic, so a store would be one writer and its
 * readers wearing a second name. The handle is a `ref` and a function.
 *
 * **A tokenless tab still issues no request.** `App.vue` mounts the rail —
 * and with it the switcher, the one caller of `load()` — only when
 * `session.authenticated`, so providing this handle costs nothing on a tab
 * that must not fetch (`frame.test.ts`'s EPIC-24-S17 case is that contract).
 */
import { type InjectionKey, inject, provide, type Ref, ref } from 'vue';
import { useApiClient } from '../api/provide.ts';

export interface ProjectHealth {
  readonly state: 'ok' | 'missing' | 'not-a-git-repo';
  readonly message: string | null;
}

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: ProjectHealth;
  readonly lastRun: { readonly runId: string; readonly label: string } | null;
}

/** `ProjectsView.vue`'s own `ProjectsApi` seam, narrowed to the one call this
 *  handle makes. */
interface ProjectsApi {
  readonly projects: {
    readonly $get: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  };
}

export interface ProjectsHandle {
  /** The daemon's rows, empty until `load()` has answered. */
  readonly rows: Ref<readonly ProjectRow[]>;
  /** The one fetch. The switcher calls it on mount; nothing else does. */
  readonly load: () => Promise<void>;
}

const PROJECTS: InjectionKey<ProjectsHandle> = Symbol('DeFlow.projects');

function createHandle(): ProjectsHandle {
  const client = useApiClient();
  const rows = ref<readonly ProjectRow[]>([]);

  async function load(): Promise<void> {
    try {
      const response = await (client as never as ProjectsApi).projects.$get();
      if (!response.ok) return;
      rows.value = [...((await response.json()) as { projects: ProjectRow[] }).projects];
    } catch {
      // KAR-24.4 AC6's own rule, carried over verbatim from the switcher: a
      // daemon that is restarting (or a spec's partial test double) must not
      // take the frame down — the handle simply holds no rows.
    }
  }

  return { rows, load };
}

/** Called once, in `App.vue`'s setup, so every frame component shares one
 *  answer. Returns the handle so the provider could read it too. */
export function provideProjects(): ProjectsHandle {
  const handle = createHandle();
  provide(PROJECTS, handle);
  return handle;
}

/**
 * The shared handle — or, for a component mounted outside the shell (a
 * component-level spec), a private one of its own, which behaves identically
 * because `createHandle` is all either path is.
 */
export function useProjects(): ProjectsHandle {
  return inject(PROJECTS, null) ?? createHandle();
}
