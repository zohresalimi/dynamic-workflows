#!/usr/bin/env node
/**
 * The `DeFlow-mock-agent` executable.
 *
 * A real bin with a real shebang and a real mode bit, shipped in the tarball
 * (docs/16-repo-layout.md §2, D17) rather than kept as a test helper — a mock
 * that only exists inside the repository cannot be used to reproduce a user's
 * bug report, which is half of what it is for.
 *
 * No build step: Node strips the types on the way in, so this file is what
 * runs, both from the workspace and from an installed tarball.
 *
 * The exit code is set rather than forced with `process.exit`, so the process
 * ends only once stdout has drained. Calling `process.exit` here would truncate
 * the frame still in the pipe, which is exactly the failure AC6 forbids.
 */
import process from 'node:process';
import { run } from '../src/main.ts';

process.exitCode = await run(process.argv.slice(2));
