/**
 * The SPA entry point. Served by DeFlowd on the same origin as the API, in dev
 * through Vite's middleware and in production from the built assets — so there
 * is no base URL to configure and no CORS to get wrong.
 */
import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
