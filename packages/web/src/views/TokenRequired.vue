<script setup lang="ts">
/**
 * KAR-16.1 AC3 — what a tab with no token looks like.
 *
 * `sessionStorage` is **per tab**, so this is not a corner case: it is what the
 * operator's second tab, and every bookmark of `http://127.0.0.1:7777/`, looks
 * like every single time. AC3 names the three things it must not be — a
 * spinner, a blank page, or a 401 retry loop — and the reason is that all three
 * are indistinguishable from a broken daemon, so the operator restarts a daemon
 * that was fine.
 *
 * So: say what happened, say exactly what to do about it, and make no request
 * at all until there is a token to send. There is deliberately no "retry"
 * button — there is nothing to retry; the missing thing is a credential that
 * only `DeFlow up` can print.
 */
import { KeyRound } from 'lucide-vue-next';
import { ref } from 'vue';
import { useSessionStore } from '../stores/useSessionStore.ts';

const session = useSessionStore();
const pasted = ref('');
const rejected = ref(false);

/**
 * The paste path, for the operator who has the URL in a clipboard but is
 * already looking at this tab. The reading of it belongs to the session store,
 * beside the rest of the token's life, so there is one place that knows what
 * the handoff looks like.
 */
function useUrl(): void {
  rejected.value = !session.acceptUrl(pasted.value);
}
</script>

<template>
  <section class="token-required" aria-labelledby="token-required-title">
    <h1 id="token-required-title" class="token-required__title">
      <KeyRound :size="18" aria-hidden="true" />
      This tab has no daemon token
    </h1>

    <p>
      Paste the URL printed by <code>DeFlow up</code>. It looks like
      <code>http://127.0.0.1:7777/#token=&lt;token&gt;</code>.
    </p>
    <p class="token-required__why">
      The token lives in the URL's fragment, which browsers never send to a server, and it is kept
      for this tab only — so a second tab, or a bookmark of the bare address, starts here.
    </p>

    <form class="token-required__form" @submit.prevent="useUrl">
      <label class="token-required__label" for="token-required-url">URL from DeFlow up</label>
      <input
        id="token-required-url"
        v-model="pasted"
        class="token-required__input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="http://127.0.0.1:7777/#token=…"
      >
      <button class="token-required__submit" type="submit">Use this URL</button>
    </form>

    <p v-if="rejected" class="token-required__error" role="alert">
      That URL carries no <code>#token=</code> fragment.
    </p>
  </section>
</template>

<style scoped>
.token-required {
  display: grid;
  gap: 0.75rem;
  max-width: 40rem;
  margin: 3rem auto;
  padding: 1.25rem;
  border: 1px solid var(--edge);
  border-radius: 0.75rem;
  background: var(--surface-raised);
}

.token-required__title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.05rem;
  font-weight: 650;
}

.token-required__why {
  color: var(--ink-muted);
  font-size: 0.875rem;
}

.token-required__form {
  display: grid;
  gap: 0.4rem;
}

.token-required__label {
  font-size: 0.8rem;
  color: var(--ink-muted);
}

.token-required__input,
.token-required__submit {
  padding: 0.5rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface);
  color: inherit;
}

.token-required__submit {
  justify-self: start;
  padding-inline: 0.9rem;
}

.token-required__error {
  color: var(--state-failed);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875em;
}
</style>
