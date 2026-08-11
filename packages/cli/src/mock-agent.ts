#!/usr/bin/env node
/**
 * The `DeFlow-mock-agent` executable — the published package's third bin.
 *
 * D17 calls `@DeFlow/mock-agent` a first-class shipped package, and "shipped"
 * means *inside this tarball as a second bin*, not published separately
 * (docs/16-repo-layout.md §2). Users need it for `DeFlow doctor`, offline demos
 * and reproducing a bug report, and none of that requires its own npm entry.
 *
 * The exit code is set rather than forced with `process.exit`: the mock agent
 * writes ACP frames on stdout, and exiting here truncates the frame still in
 * the pipe — the failure `packages/mock-agent/bin/mock-agent.ts` documents.
 */
import { run } from '@DeFlow/mock-agent';
import process from 'node:process';

process.exitCode = await run(process.argv.slice(2));
