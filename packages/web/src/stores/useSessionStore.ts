/**
 * KAR-16.1 AC2/AC3 — whether this tab holds the daemon token, and what it does
 * when it does not.
 *
 * `deflow up` prints `http://127.0.0.1:7777/#token=<token>`. Fragments are
 * never sent to the server, so the token cannot land in an access log; the tab
 * reads it once, puts it in `sessionStorage`, strips it out of the address bar
 * with `history.replaceState`, and sends it as a header thereafter
 * (../api/token.ts, docs/11-api-and-realtime.md §8).
 *
 * The part that is this story's rather than KAR-15.2's is the **negative
 * case**. A tab opened at `http://127.0.0.1:7777/` with no fragment and no
 * stored token has no way to get one, and the three things it must not do are
 * named in AC3: a spinner, a blank page, or a 401 retry loop. `sessionStorage`
 * is per tab, so this is not a corner case — it is what the operator's *second*
 * tab looks like every single time.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { acquireToken, clearToken, readToken, TOKEN_STORAGE_KEY } from '../api/token.ts';

/**
 * The handoff URL `deflow up` prints. Anchored on the fragment, and matching
 * exactly the character class `mintDaemonToken()` produces, so a URL with a
 * query string that happens to contain the word `token` is rejected rather than
 * half-read.
 */
const HANDOFF_URL = /#token=([A-Za-z0-9_-]+)$/;

export const useSessionStore = defineStore('session', () => {
  /**
   * Read at construction from `sessionStorage`, which `acquireToken()` in
   * `main.ts` has already populated from the fragment if there was one. It is
   * *not* re-read here: `acquireToken` is idempotent, but calling it a second
   * time from a store makes the moment the address bar is cleaned depend on
   * when a component happened to mount.
   */
  const token = ref<string | null>(readToken());

  const authenticated = computed(() => token.value !== null && token.value !== '');

  /** After a fragment arrives late — a paste into the same tab. */
  function acquire(): void {
    token.value = acquireToken();
  }

  /**
   * The paste path (AC3): the operator has the URL in a clipboard and is
   * already looking at the tab that needs it.
   *
   * The token is taken out of the fragment and stored, and the URL is never
   * requested — a fragment is not sent to a server, and this one must not
   * become the first one that is. Answers whether it held a token at all.
   */
  function acceptUrl(url: string): boolean {
    const handoff = HANDOFF_URL.exec(url.trim());
    const pasted = handoff?.[1];
    if (pasted === undefined) return false;

    globalThis.sessionStorage?.setItem(TOKEN_STORAGE_KEY, pasted);
    token.value = readToken();
    return true;
  }

  function forget(): void {
    clearToken();
    token.value = null;
  }

  /**
   * What the API client is handed. A function, not the string, so a tab that
   * acquires its token after the client was built does not need a second one.
   */
  const current = (): string | null => token.value;

  return { token, authenticated, acquire, acceptUrl, forget, current };
});

export type SessionStore = ReturnType<typeof useSessionStore>;
