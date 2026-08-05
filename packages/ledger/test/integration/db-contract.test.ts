/**
 * KAR-03.1 — the real better-sqlite3 adapter against the shared `Db` contract.
 *
 * The same suite runs against the fake in
 * packages/testkit/src/fake-db.test.ts. Two implementations passing one suite is
 * what "the port is for substitutability, not abstraction" has to mean in
 * practice — and the fake cannot import a driver type, so a port that leaked one
 * would fail to compile there rather than being noticed in review.
 *
 * Verifies: KAR-03.1 test plan row 7 (real half) · AC1
 */
import { dbContract } from '@DeFlow/testkit';
import { openWrite } from '../../src/index.ts';

dbContract('better-sqlite3, file-backed', (file) => openWrite(file));
