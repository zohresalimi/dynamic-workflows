/**
 * The run id the patch-apply crash-fuzz worker writes, in a module of its own.
 *
 * Separate from the worker because the worker's body *runs on import*: it is a
 * script, not a library, and a harness that imported a constant from it would
 * open a ledger and apply a patch inside the test process.
 */
export const PATCH_RUN = 'run_20260808T120000Z_b41c73';
