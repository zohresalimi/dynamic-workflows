/**
 * KAR-16.4 AC10 — the query layer, and the line it must not cross
 * (docs/12-frontend-architecture.md §3.4).
 *
 * > **If the answer changes because an event was appended, it is a projection.
 * > If it changes because a file on disk changed, it is a query.**
 *
 * That sentence is the whole design rule, and `@pinia/colada` is on the second
 * side of it only. A fetch cache is a good answer to *"what does this machine
 * have?"* and a bad answer to *"what is this run doing?"* — the second is a
 * stream the tab is already holding, and putting it behind a cache means two
 * sources of truth that disagree for exactly as long as the stale window, which
 * is the interval an operator spends staring at a node that finished.
 *
 * Three reads are on the query side in this build, and each is the same shape
 * of fact:
 *
 * | Endpoint                | Changes when                                     |
 * | ----------------------- | ------------------------------------------------ |
 * | `GET /api/providers`    | a vendor CLI is installed, upgraded or re-probed |
 * | `GET /api/config`       | the workspace config file is edited              |
 * | `GET /api/artifacts/:sha` | never — the address *is* the hash of the bytes |
 *
 * `/api/runs` — the run **list**, "which runs does this directory hold" — is
 * the fourth member of that table and is sanctioned in
 * `SANCTIONED_QUERY_PATHS` below, but the daemon serves no list route in this
 * build: EPIC-15 shipped `POST /api/runs` and `GET /api/runs/:id`, and the
 * latter is a *ledger-derived summary* that this rule puts on the projection
 * side, not the query side (its own docblock says the client "keeps it current
 * from the stream rather than by coming back here"). Adding the list route is a
 * daemon change and belongs with the story that needs it.
 *
 * ## Why these are exported as options rather than as composables
 *
 * `providersQuery(client)` returns `{ key, query }` — exactly what Colada's
 * `useQuery` takes. Two consequences, both wanted: a spec can call `.query()`
 * and assert *which request it made* without mounting anything, and
 * `packages/cli` can reuse the same fetcher against a `--daemon` of its own
 * without pulling a Vue reactivity graph into a CLI.
 */
import type { ApiClient } from './client.ts';

/**
 * The API paths the query layer is allowed to own.
 *
 * Data, not prose, because `test/ui-foundation.test.ts` reads it: the lint rule
 * that keeps run state out of the fetch cache checks this list against every
 * key defined in the package, so adding a path here is a deliberate edit
 * somebody has to justify rather than a fourth `useQuery` nobody noticed.
 */
export const SANCTIONED_QUERY_PATHS = [
  '/api/runs',
  '/api/providers',
  '/api/config',
  '/api/artifacts/:sha',
] as const;

/** The first segment of every key this module defines. */
export const QUERY_KEY_ROOTS = ['runs', 'providers', 'config', 'artifacts'] as const;

export type QueryKeyRoot = (typeof QUERY_KEY_ROOTS)[number];

/** What Colada's `useQuery` takes, spelled out so nothing here imports Vue. */
export interface QueryDefinition<T> {
  readonly key: readonly [QueryKeyRoot, ...string[]];
  readonly query: () => Promise<T>;
}

/** One provider row, as `GET /api/providers` reports it. */
export interface ProviderRow {
  readonly provider: string;
  readonly installed: boolean;
  readonly version?: string | null;
}

export interface WorkspaceConfigDocument {
  readonly cwd: string;
  readonly config: Record<string, unknown>;
}

const refuse = (what: string, status: number): never => {
  throw new Error(`${what} failed with ${status}`);
};

/**
 * The adapters this machine has, with the versions and capability manifests the
 * probe recorded.
 *
 * A `GET` with no side effects: the daemon reads its `provider_capabilities`
 * history rather than re-probing, which is what makes this cacheable at all.
 */
export function providersQuery(client: ApiClient): QueryDefinition<readonly ProviderRow[]> {
  return {
    key: ['providers'],
    async query() {
      const response = await client.providers.$get();
      if (!response.ok) refuse('reading the provider list', response.status);
      return (await response.json()) as readonly ProviderRow[];
    },
  };
}

/**
 * The workspace config, for the repository at `cwd`.
 *
 * Keyed on `cwd` because the answer is per repository: one tab can be looking
 * at runs from two checkouts, and a key that forgot which would serve the
 * wrong file's settings to the second.
 */
export function configQuery(
  client: ApiClient,
  cwd: string,
): QueryDefinition<WorkspaceConfigDocument> {
  return {
    key: ['config', cwd],
    async query() {
      const response = await client.config.$get({ query: { cwd } });
      if (!response.ok) refuse(`reading the config for ${cwd}`, response.status);
      return (await response.json()) as WorkspaceConfigDocument;
    },
  };
}

/**
 * The bytes behind a content-addressed handle.
 *
 * The most cacheable read in the system and the one it would be silliest to
 * re-fetch: the key *is* the hash of the content, so a hit can never be stale.
 * Returned as text — the inspector renders diffs and packets, not binaries —
 * and a caller that wants the raw response can ask the client itself.
 */
export function artifactQuery(client: ApiClient, sha: string): QueryDefinition<string> {
  return {
    key: ['artifacts', sha],
    async query() {
      const response = await client.artifacts[':sha'].$get({ param: { sha } });
      if (!response.ok) refuse(`reading artifact ${sha}`, response.status);
      return await response.text();
    },
  };
}
