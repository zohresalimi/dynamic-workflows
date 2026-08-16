/**
 * Migration 0017 — `connector`, KAR-22.4's record that a project may use a
 * service.
 *
 * **Read the columns.** There is no `token`, no `client_id`, no `secret`, no
 * `refresh_token` and no `expires_at`, and that is the whole design rather than
 * an omission to be filled in later. ADR-0003's amendment of 2026-08-16 says
 * DeFlow never possesses a credential belonging to a third-party service; for
 * GitHub the token lives in the GitHub CLI's own credential store, put there by
 * `gh auth login` against GitHub's own application, and DeFlow reaches GitHub
 * by spawning `gh`. What this table holds is consent: *this project may use
 * that service*. Adding a credential column here is a change to the ADR, not a
 * change to a schema.
 *
 * A **table, not an event stream**, for the reason 0016 gives about projects: a
 * connector has an add and a remove, and expressing CRUD as events would mean a
 * projection over two kinds to answer "is this connected".
 *
 * The primary key is `(project_id, service)` because that is the uniqueness AC5
 * asserts — one connector per service per project, and a connector on project A
 * that is not one on project B. `ON DELETE CASCADE` is deliberate and safe in a
 * way KAR-22.1's rule about never destroying anything survives: removing a
 * project already destroys nothing but DeFlow's own row, and a connector row is
 * one of DeFlow's own rows. A dangling connector for a project that is gone
 * would otherwise be readable by the next project to mint the same id, which
 * cannot happen, and unreadable by anything else, which is worse than absent.
 */
import type { Migration } from '../migrate.ts';

export const migration0017Connectors: Migration = {
  id: 17,
  name: 'connectors',
  up(db) {
    db.exec(`
      CREATE TABLE connector (
        project_id TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        service    TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, service)
      ) STRICT
    `);
  },
};
