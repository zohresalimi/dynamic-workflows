/**
 * The constants the two rival proposers and their harness share.
 *
 * A module of its own because the worker's body *runs on import*: it is a
 * script, not a library, and a harness importing a constant from it would open
 * the ledger and apply a patch inside the test process.
 */
export const RIVAL_RUN = 'run_20260808T130000Z_c92f18';

/** Where the harness leaves the base hash both rivals derive against. */
export const RIVAL_BASE_HASH_FILE = 'base-plan-hash.txt';
