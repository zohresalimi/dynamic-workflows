/**
 * @DeFlow/e2e — cross-process specs that boot a real DeFlowd on an ephemeral
 * port with fake agents on PATH and drive a real browser. It depends on the
 * published `deflow` package, not on @DeFlow/daemon, so the specs exercise
 * the artefact users actually install.
 *
 * e2e is not a library — it has no "exports" and ships nothing. KAR-01.4
 * fills this directory with real specs under `e2e/**\/*.test.ts`. Until then
 * this file is the only thing here, so that `tsc -b` (KAR-01.2, AC2/AC3) has
 * something to typecheck for this package rather than failing with
 * "No inputs were found". Delete it once a real spec file exists.
 */
export {};
