/**
 * The SPA entry point. Served by DeFlowd on the same origin as the API, in dev
 * through Vite's middleware and in production from the built assets — so there
 * is no base URL to configure and no CORS to get wrong.
 */

import { acquireToken } from './api/token.ts';
import { createDeFlowApp } from './app/create-app.ts';
import './styles/theme.css';

// KAR-15.2 AC8 — before anything renders or requests: read the handoff
// fragment `deflow up` printed, put it in `sessionStorage`, and rewrite the
// history entry so the address bar stops carrying a credential. Doing it here
// rather than in a component means it happens exactly once per page life, and
// before the first request that would need it — including before the router
// reads the URL, which is why the fragment is gone by the time anything routes.
acquireToken();

createDeFlowApp().app.mount('#app');
