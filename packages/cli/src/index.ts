/**
 * DeFlow — the only package published to npm.
 *
 * `bin`, `files` and the tsdown config that inlines every @DeFlow/* package
 * (noExternal: [/^@DeFlow\//], external: ["@lydell/node-pty"]) arrive with
 * EPIC-18. Declaring bins before dist/ exists would make `pnpm install` link
 * paths that are not there yet, so they are deliberately absent from the
 * scaffold.
 */
export {};
