/**
 * The two run ids the `crash-resume-seq-gap` fixture is built from.
 *
 * Their own module because the writer (`./crash-resume-writer.ts`) opens a
 * ledger and starts appending the moment it is imported — it is a child process
 * entry point, not a library — so the builder cannot take these constants from
 * it without running a writer inside itself.
 */
import { type RunId, RunIdSchema } from '@DeFlow/core';

/** The run whose sequence the fixture is named for: 4, 5, 7, 8, 11. */
export const CRASH_RESUME_RUN: RunId = RunIdSchema.parse('run_20260810T101500Z_c4a5b1');

/** The run that owns 6, 9 and 10 — the numbers a gap detector calls "lost". */
export const CRASH_RESUME_OTHER_RUN: RunId = RunIdSchema.parse('run_20260810T101500Z_d17e02');
