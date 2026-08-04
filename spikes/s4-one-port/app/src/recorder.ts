/**
 * The page's own record of its stream, kept where a test driver can read it.
 *
 * Deliberately outside the `.vue` file: an HMR update re-executes the SFC
 * module and nothing else, so a stream owned by this module is one an SFC edit
 * cannot accidentally tear down — which is precisely the property AC3 asks
 * about. If the numbers below reset when `Live.vue` is edited, the "hot reload
 * without dropping the stream" claim was never true.
 *
 * `?since=` is the mandatory half of the resume contract: after a reload the
 * browser opens a *fresh* `EventSource`, which sends no `Last-Event-ID`, so the
 * page has to say where it got to. `sessionStorage` is what survives the
 * reload.
 */

import { ref } from 'vue';

export interface PageState {
  readonly pageId: string;
  seqs: number[];
  opens: number;
  errors: number;
  everNotOpen: boolean;
  hydratedSince: number | null;
  readyState: number;
}

const LAST_SEEN = 's4.lastSeq';

const stored = sessionStorage.getItem(LAST_SEEN);
const hydratedSince = stored === null ? null : Number(stored);

export const state: PageState = {
  pageId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  seqs: [],
  opens: 0,
  errors: 0,
  everNotOpen: false,
  hydratedSince,
  readyState: 0,
};

export const count = ref(0);

const url = hydratedSince === null ? '/api/stream' : `/api/stream?since=${hydratedSince}`;
const source = new EventSource(url);

source.addEventListener('open', () => {
  state.opens += 1;
  state.readyState = source.readyState;
});

source.addEventListener('error', () => {
  state.errors += 1;
  state.readyState = source.readyState;
});

source.addEventListener('tick', (event) => {
  const seq = Number((event as MessageEvent<string>).lastEventId);
  state.seqs.push(seq);
  state.readyState = source.readyState;
  sessionStorage.setItem(LAST_SEEN, String(seq));
  count.value = state.seqs.length;
});

// readyState is sampled rather than trusted at the end: "never left OPEN" is a
// claim about every instant of the run, and a reconnect would show up here as a
// CONNECTING sample even if it healed before anyone asked.
setInterval(() => {
  state.readyState = source.readyState;
  // Only once it has been open at all: the first moments of any page load are
  // CONNECTING, and that is not what "left OPEN" means.
  if (state.opens > 0 && source.readyState !== EventSource.OPEN) state.everNotOpen = true;
}, 50);

Object.assign(window, { __s4: state });
