/**
 * `deflow setup` (KAR-20.2) — one command, five steps, and no step that
 * believes an exit code.
 *
 * The failure this replaces happened on 2026-08-12 and is worth keeping in
 * view while reading every branch below: `pnpm link --global` **exited 0**,
 * printed a success, and produced no usable command, because pnpm's global bin
 * directory was not on `PATH` and nothing said so. The operator followed the
 * README and got a `not recognized` back from the shell for the command it
 * named.
 *
 * So the design rule is that **every step is verified by observation**. The
 * install is confirmed by spawning `deflow --version` through a shell resolving
 * the `PATH` a *new* terminal will have — never this process's own, which under
 * `npx deflowai setup` contains an npx cache directory that resolves `deflow` no
 * matter what happened — and the version is read out of its stdout rather than
 * inferred from a zero.
 *
 * The second rule is **honesty about the operator's machine**. Putting a
 * directory on `PATH` means editing a file in somebody's home directory, so the
 * file is named, the line is printed, the question is asked, a bare Enter is
 * *no*, and a second run appends nothing. And when it cannot be done — an
 * unwritable profile, a shell nobody recognises, a `PATH` managed by something
 * else — the command says exactly what to add and where, and **exits non-zero**,
 * because a green report over a broken install is the failure this whole epic
 * came from.
 *
 * Returns rather than exits and writes to no stream itself: `bin.ts` owns the
 * process, which is the same split `runDoctor`, `runInit` and `runUp` use, and
 * is what makes every scenario above testable without one.
 *
 * Verifies: EPIC-20-S11 … EPIC-20-S24 · AC1-AC14
 */
import { installCommand, providerVerdict } from '@DeFlow/adapters';
import type { Clock } from '@DeFlow/core';
import { pathRoots, resolveDataDir, systemClock } from '@DeFlow/daemon';
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { COMMAND, PACKAGE_NAME, SHORT_ALIAS } from '../command-name.ts';
import {
  installMode,
  isAffirmative,
  offerAdapterInstalls,
  resolveProviderStates,
} from '../doctor/agent-install.ts';
import { type DoctorReport, toReport } from '../doctor/report.ts';
import { nextAction, type Report, type ReportState, renderReport } from '../render/report.ts';
import { plainStyle, type Style } from '../render/style.ts';
import {
  exitCodeFor,
  freshShellPath,
  parseVersion,
  profileTarget,
  SETUP_STEPS,
  type SetupStep,
  type SetupStepId,
  windowsRefusal,
} from './plan.ts';
import { appendProfileLine, profileHasLine } from './profile.ts';

export interface SetupOptions {
  /** The directory the operator ran the command from. Nothing is written to
   * it — it is here so that "no lockfile in the operator's directory" is a
   * property of where the install ran (AC11). */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Emit one machine document instead of the report. Never prompts (AC10). */
  readonly json?: boolean;
  /** Write the profile line without asking, and treat the adapter offer as
   * answered yes (AC5, AC10). */
  readonly yes?: boolean;
  /** KAR-18.8's `--fix`: install missing ACP adapters without asking. */
  readonly fix?: boolean;
  /**
   * The npm specifier to install, `deflow` by default.
   *
   * An input rather than a constant because both of the other entry points
   * need it: the macOS install script pins a version, and the release gate
   * verifies the packed tarball rather than whatever the registry is serving.
   * It is never a second *behaviour* — the same five steps run either way.
   */
  readonly from?: string | undefined;
  readonly clock?: Clock;
  readonly style?: Style;
  /** Whether stdout is a terminal, so a question can be asked at all. */
  readonly isTty?: () => boolean;
  /** Prints one question and reads the answer — the only reader of stdin. */
  readonly prompt?: (question: string) => Promise<string>;
}

export interface SetupResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly steps: readonly SetupStep[];
}

/**
 * The package this command installs, and the only thing it may install without
 * being asked (AC11).
 *
 * `PACKAGE_NAME` rather than `COMMAND`: `npm install -g <spec>` takes a
 * **package**, and `deflow` on the registry belongs to somebody else's Redis
 * library. The two were the same string until 2026-08-15 and are not any more,
 * which is the sort of coincidence that becomes a defect the moment it ends.
 */
const PACKAGE = PACKAGE_NAME;

/** Enough of npm's output to diagnose it, without pasting a whole install log. */
const STDERR_CAP = 4000;

function trimStderr(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length <= STDERR_CAP
    ? trimmed
    : `${trimmed.slice(0, STDERR_CAP)}\n… (truncated at ${STDERR_CAP} characters)`;
}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One child, to completion, with its output captured and stdin closed. */
function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<Ran> {
  return new Promise<Ran>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      // `ignore` rather than `inherit`: nothing this command spawns may read
      // the operator's stdin, which is what keeps a scripted run from blocking
      // on a question npm decided to ask (AC10).
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The first `name` on `roots` that is an executable file, or `null`. */
function resolveOn(roots: readonly string[], name: string): string | null {
  for (const root of roots) {
    const candidate = join(root, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // The next root, for every reason: absent, a directory, not executable.
    }
  }
  return null;
}

/**
 * A POSIX shell to run the verification through.
 *
 * Resolved off this process's own `PATH`, and `/bin/sh` when that fails: the
 * shell is the *instrument*, not the subject, and the `PATH` under test is the
 * one handed to it in the child's environment.
 */
function shellBinary(roots: readonly string[]): string {
  return resolveOn(roots, 'sh') ?? '/bin/sh';
}

/**
 * AC3 — `deflow --version`, spawned in a shell resolving `path`.
 *
 * `command -v` first and on its own line, so the answer carries *where* the
 * command resolved as well as what it printed; `parseVersion` reads the last
 * line, which is the version. Nothing here reads this process's own `PATH`,
 * which is the entire point: a `deflow` that resolves only because npx put it
 * on our `PATH` must not satisfy a check about the operator's next terminal.
 */
async function probeVersion(input: {
  readonly sh: string;
  readonly path: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Which name to ask. `COMMAND` unless the alias is the subject. */
  readonly command?: string;
}): Promise<{ readonly ran: Ran; readonly version: string | null; readonly resolved: string }> {
  const command = input.command ?? COMMAND;
  const ran = await run(
    input.sh,
    ['-c', `command -v ${command} || exit 127\n${command} --version`],
    { cwd: input.cwd, env: { ...input.env, PATH: input.path } },
  );
  const lines = ran.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return { ran, version: parseVersion(ran.stdout), resolved: lines[0] ?? '' };
}

/** The state of every step before anything has run — replaced as each one
 * answers, and left as `skipped` for the ones a failure stopped. */
function skipped(id: SetupStepId, reason: string): SetupStep {
  return { id, state: 'skipped', detail: reason };
}

/**
 * `'…'`, the way a POSIX shell reads a literal.
 *
 * Single quotes rather than `JSON.stringify`, because AC5 says the **exact**
 * line is printed and the line itself contains double quotes —
 * `export PATH="…:$PATH"`. JSON quoting would print `\"` where the operator has
 * to type `"`, which is a subtly wrong instruction, and subtly wrong is the
 * failure mode this whole story is about.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command an operator can paste to do the profile edit themselves — and
 * which carries the exact line, unescaped, inside it. */
function appendCommand(file: string, line: string): string {
  return `printf '%s\\n' ${shellQuote(line)} >> ${shellQuote(file)}`;
}

/**
 * `<dataDir>/setup-install/` — where npm runs, so that no lockfile and no
 * `node_modules` can land in the directory the operator happened to be in
 * (AC11). Created and removed around the attempt, exactly as KAR-18.8 does.
 */
const INSTALL_SCRATCH = 'setup-install';

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const platform = options.platform ?? process.platform;
  const style = options.style ?? plainStyle(options.env);

  // AC13 — before any filesystem access at all. Half-working on Windows means
  // a POSIX profile path, a `PATH` joined on `:` and a `chmod`, each of which
  // leaves the machine worse than it started.
  if (platform === 'win32') {
    return { exitCode: 1, stdout: '', stderr: windowsRefusal(), steps: [] };
  }

  const env = options.env;
  const clock = options.clock ?? systemClock;
  const roots = pathRoots(env);
  const dataDir = resolveDataDir(env);
  const spec = options.from ?? PACKAGE;
  const tty = (options.isTty ?? (() => process.stdout.isTTY === true))();
  const json = options.json === true;
  const yes = options.yes === true;
  // `Promise.resolve('')` rather than an `async` arrow: the fallback answers
  // nothing, and an empty answer is *no* (KAR-18.8 AC4). It is never reached
  // with a real prompt attached.
  const ask = options.prompt ?? ((): Promise<string> => Promise.resolve(''));
  const sh = shellBinary(roots);

  const steps = new Map<SetupStepId, SetupStep>(
    SETUP_STEPS.map((id) => [id, skipped(id, 'this step did not run')]),
  );
  const record = (step: SetupStep): SetupStep => {
    steps.set(step.id, step);
    return step;
  };

  // ---- what this machine looks like, before anything is changed ------------

  const npm = resolveOn(roots, 'npm');
  const prefix =
    npm === null
      ? null
      : (await run(npm, ['prefix', '-g'], { cwd: options.cwd, env })).stdout.trim();
  const binDir = prefix === null || prefix === '' ? null : join(prefix, 'bin');

  // EPIC-20-S15's second scenario: pnpm's global bin directory is somewhere
  // else again, and reporting only npm's would leave a `pnpm link --global`
  // user exactly where 2026-08-12 left them.
  const pnpm = resolveOn(roots, 'pnpm');
  const pnpmBinRan =
    pnpm === null ? null : await run(pnpm, ['bin', '-g'], { cwd: options.cwd, env });
  const pnpmBin =
    pnpmBinRan === null || pnpmBinRan.code !== 0 || pnpmBinRan.stdout.trim() === ''
      ? null
      : pnpmBinRan.stdout.trim();

  const inherited = freshShellPath({ envPath: env.PATH ?? '', add: [] }).split(delimiter);
  const onPath = binDir !== null && inherited.includes(binDir);
  const target = profileTarget({
    shell: env.SHELL,
    platform,
    home: env.HOME ?? '',
    binDir: binDir ?? '',
  });
  const profileProvides =
    target.file !== null && binDir !== null && profileHasLine(target.file, target.line);

  /** The `PATH` a shell opened now would have — recomputed after the link step,
   * because that step is what can change the answer. */
  const freshPath = (provided: boolean): string =>
    freshShellPath({
      envPath: env.PATH ?? '',
      add: binDir !== null && provided ? [binDir] : [],
    });

  // ---- 1. install ---------------------------------------------------------

  const beforeInstall = await probeVersion({
    sh,
    path: freshPath(onPath || profileProvides),
    env,
    cwd: options.cwd,
  });

  let install: SetupStep;
  if (beforeInstall.version !== null) {
    install = record({
      id: 'install',
      state: 'ok',
      detail:
        `already — ${COMMAND} ${beforeInstall.version} is installed at ${beforeInstall.resolved} ` +
        'and resolves in the PATH a new shell will have, so nothing was installed. Upgrade with ' +
        `"${installCommand(`${spec}@latest`)}" when you want a newer one.`,
      data: { installed: false, version: beforeInstall.version, path: beforeInstall.resolved },
    });
  } else if (npm === null) {
    install = record({
      id: 'install',
      state: 'fail',
      detail:
        'no executable "npm" was found on PATH, so nothing was run. DeFlow is distributed as an ' +
        'npm package and needs Node 24 or newer — install Node, then run this command again.',
      action: 'install Node 24 or newer, then re-run this command',
      data: { installed: false },
    });
  } else {
    const scratch = join(dataDir, INSTALL_SCRATCH);
    mkdirSync(scratch, { recursive: true });
    const startedAt = clock.now();
    // One attempt, no retry (AC12/NF1): three retries on a machine with no
    // egress is three npm timeouts to be told the same thing once.
    const attempt = await run(npm, ['install', '-g', spec], { cwd: scratch, env });
    const elapsedMs = Math.max(0, clock.now() - startedAt);
    rmSync(scratch, { recursive: true, force: true });

    install = record(
      attempt.code === 0
        ? {
            id: 'install',
            state: 'ok',
            detail:
              `ran "${installCommand(spec)}" — exit 0 in ${String(elapsedMs)} ms. Whether that ` +
              'produced a usable command is the verify step below, not this one.',
            data: { installed: true, command: installCommand(spec), exitCode: 0, elapsedMs },
          }
        : {
            id: 'install',
            state: 'fail',
            detail:
              `ran "${installCommand(spec)}" — ` +
              `${attempt.code === null ? 'no process was started' : `exit ${String(attempt.code)}`}` +
              ` in ${String(elapsedMs)} ms, once, with no retry.` +
              (attempt.stderr.trim() === '' ? '' : `\nnpm said:\n${trimStderr(attempt.stderr)}`),
            action: installCommand(spec),
            data: {
              installed: false,
              command: installCommand(spec),
              exitCode: attempt.code,
              elapsedMs,
              stderr: trimStderr(attempt.stderr),
            },
          },
    );
  }

  if (install.state === 'fail') {
    for (const id of ['link', 'verify', 'doctor', 'adapters'] as const) {
      record(skipped(id, 'the install step failed, so this step did not run and changed nothing'));
    }
    return finish(steps, style, json);
  }

  // ---- 2. link ------------------------------------------------------------

  // AC4 — the sentence nobody printed on 2026-08-12. Which directory, and that
  // it is invisible to the shell the operator will type into next.
  const where =
    binDir === null
      ? ''
      : `The global bin directory npm installs into is ${binDir}, and it is not on your PATH — ` +
        'which is how an install that "succeeded" leaves you with no command.' +
        (pnpmBin === null || pnpmBin === binDir || inherited.includes(pnpmBin)
          ? ''
          : ` pnpm's own global bin directory is ${pnpmBin}, and it is not on your PATH either — ` +
            'a "pnpm link --global" would land there rather than in npm\'s directory.');

  let provided = onPath || profileProvides;
  if (binDir === null) {
    record({
      id: 'link',
      state: 'fail',
      detail:
        '"npm prefix -g" did not answer with a directory, so where the command was installed is ' +
        'unknown and nothing could be put on PATH. Run "npm prefix -g" yourself to see what it says.',
      action: 'npm prefix -g',
    });
  } else if (!existsSync(binDir)) {
    // The directory npm named is an observation too, not a string to be
    // trusted. Found by performing AC15: under a path with a UUID-shaped
    // segment, npm 11 redacts its *own* output, so "npm prefix -g" answered
    // with a directory that had never existed. Appending a PATH line pointing
    // at it would leave the operator's next shell exactly where 2026-08-12
    // left them, having edited a dotfile to get there.
    record({
      id: 'link',
      state: 'fail',
      detail:
        `"npm prefix -g" named ${binDir}, but that directory does not exist, so adding it to ` +
        'your PATH would achieve nothing and nothing was written to a shell profile. Run ' +
        '"npm prefix -g" yourself: if it answers with a path you do not recognise, npm is ' +
        'misreporting its own prefix and the install went somewhere else.',
      action: 'npm prefix -g',
      data: { binDir, exists: false, wrote: false },
    });
  } else if (onPath) {
    record({
      id: 'link',
      state: 'ok',
      detail: `already — ${binDir} is on your PATH, so nothing needed adding to a shell profile.`,
      data: { binDir, onPath: true, wrote: false },
    });
  } else if (profileProvides) {
    // `target.file` is a string here: `profileProvides` is only true when it
    // was one, and TypeScript carries that narrowing through the alias.
    record({
      id: 'link',
      state: 'ok',
      detail:
        `already — ${target.file} already carries this line, so nothing was written. ${where}\n  ` +
        target.line,
      data: { binDir, onPath: false, profile: target.file, line: target.line, wrote: false },
    });
    provided = true;
  } else if (target.file === null) {
    // AC7 — an unrecognised shell is told, not guessed at. Writing bash syntax
    // into a file that shell never reads is worse than doing nothing.
    record({
      id: 'link',
      state: 'warn',
      detail:
        `${where} $SHELL is ${JSON.stringify(env.SHELL ?? '')}, and this command could not work ` +
        'out which file that shell reads, so nothing was written. Add this line to your shell ' +
        `profile yourself: ${target.line}`,
      action: target.line,
      data: { binDir, onPath: false, profile: null, line: target.line, wrote: false },
    });
  } else {
    const question =
      `${where}\nMay I append this line to ${target.file}?\n  ${target.line}\n` +
      'It is the only change made outside the install itself. [y/N] ';
    const consented = yes || (tty && !json && isAffirmative(await ask(question)));

    if (!consented) {
      record({
        id: 'link',
        state: 'warn',
        detail:
          `${where} Nothing was written: ` +
          (tty && !json
            ? 'the question above was not answered yes.'
            : 'stdout is not a terminal and --yes was not passed, so there was nobody to ask.') +
          ` Add this line to ${target.file} yourself, then open a new shell:\n  ${target.line}`,
        action: appendCommand(target.file, target.line),
        data: { binDir, onPath: false, profile: target.file, line: target.line, wrote: false },
      });
    } else {
      try {
        const outcome = appendProfileLine({ file: target.file, line: target.line, clock });
        provided = true;
        record({
          id: 'link',
          state: 'ok',
          detail:
            outcome === 'already'
              ? `already — ${target.file} already carries this line, so nothing was written a ` +
                `second time:\n  ${target.line}`
              : `appended this line to ${target.file}:\n  ${target.line}\n${where} Shells already ` +
                'open will not see it — that is what the verify step below checks for the ' +
                '*next* one.',
          data: {
            binDir,
            onPath: false,
            profile: target.file,
            line: target.line,
            wrote: outcome === 'appended',
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record({
          id: 'link',
          state: 'fail',
          detail:
            `could not write ${target.file}: ${message}. ${where} Nothing was changed. Add this ` +
            `line to ${target.file} — or to whichever file your shell does read — yourself:\n  ` +
            target.line,
          action: appendCommand(target.file, target.line),
          data: { binDir, onPath: false, profile: target.file, line: target.line, wrote: false },
        });
      }
    }
  }

  const link = steps.get('link') as SetupStep;
  if (link.state === 'fail') {
    for (const id of ['verify', 'doctor', 'adapters'] as const) {
      record(skipped(id, 'the link step failed, so this step did not run and changed nothing'));
    }
    return finish(steps, style, json);
  }

  // ---- 3. verify ----------------------------------------------------------

  const path = freshPath(provided);
  const probed = await probeVersion({ sh, path, env, cwd: options.cwd });
  const command = `${COMMAND} --version`;
  const aliasCommand = `${SHORT_ALIAS} --version`;
  // The second name, asked the same way and for the same reason. npm links
  // every key in a `bin` map, so an alias that is not there afterwards means
  // the install is not what the manifest said — and finding that out here is
  // cheaper than an operator finding it out at a prompt next week. It is not a
  // failed install, though: the command works, so this can only lower the step
  // to `warn`.
  const aliasProbed =
    probed.version === null
      ? null
      : await probeVersion({ sh, path, env, cwd: options.cwd, command: SHORT_ALIAS });
  const aliasAgrees = aliasProbed !== null && aliasProbed.version === probed.version;

  const verify = record(
    probed.version !== null
      ? aliasAgrees
        ? {
            id: 'verify',
            state: 'ok',
            detail:
              `ran "${command}" in a shell resolving the PATH a new terminal will have: it ` +
              `answered ${probed.version}, from ${probed.resolved}. "${aliasCommand}" — the ` +
              `short alias, the same program under a second name — answered the same from ` +
              `${aliasProbed.resolved}. These are observations, not inferences from the ` +
              "install's exit code.",
            data: {
              command,
              version: probed.version,
              path: probed.resolved,
              aliasCommand,
              aliasVersion: aliasProbed.version,
              aliasPath: aliasProbed.resolved,
            },
          }
        : {
            id: 'verify',
            state: 'warn',
            detail:
              `ran "${command}" in a shell resolving the PATH a new terminal will have: it ` +
              `answered ${probed.version}, from ${probed.resolved}, so the command works. The ` +
              `short alias "${SHORT_ALIAS}" did not: "${aliasCommand}" ` +
              (aliasProbed?.version === null || aliasProbed === null
                ? 'did not resolve there. '
                : `answered ${String(aliasProbed.version)} instead. `) +
              `Every other step is unaffected — "${COMMAND}" is what everything else uses — but ` +
              `"${SHORT_ALIAS}" will not work until this package is reinstalled.`,
            action: `${installCommand(`${spec}@latest`)}    # to pick up the "${SHORT_ALIAS}" alias`,
            data: {
              command,
              version: probed.version,
              path: probed.resolved,
              aliasCommand,
              aliasVersion: aliasProbed?.version ?? null,
            },
          }
      : {
          id: 'verify',
          state: 'fail',
          detail:
            `ran "${command}" in a shell resolving the PATH a new terminal will have and ` +
            (probed.ran.code === 127 || probed.resolved === ''
              ? `the command did not resolve at all (exit ${String(probed.ran.code)}). The steps ` +
                'above may have reported success; this is the check that says whether they ' +
                'produced a working command, and they did not.'
              : `it exited ${String(probed.ran.code)} and printed nothing that parses as a ` +
                `version:\n${trimStderr(`${probed.ran.stdout}\n${probed.ran.stderr}`)}`),
          action: link.action ?? `open a new shell and run "${command}"`,
          data: { command, version: null, exitCode: probed.ran.code },
        },
  );

  // `fail`, not `!== 'ok'`: a `warn` here means the command answered and only
  // its second name did not, and stopping a working install short of `doctor`
  // over a missing shorthand would be the wrong trade in both directions.
  if (verify.state === 'fail') {
    for (const id of ['doctor', 'adapters'] as const) {
      record(
        skipped(
          id,
          `the verify step failed, so "${COMMAND}" was not run again and nothing was installed`,
        ),
      );
    }
    return finish(steps, style, json);
  }

  // ---- 4. doctor ----------------------------------------------------------

  const doctorRan = await run(sh, ['-c', `${COMMAND} doctor --json --skip-conformance`], {
    cwd: options.cwd,
    env: { ...env, PATH: path },
  });

  let doctorReport: DoctorReport | null = null;
  try {
    doctorReport = JSON.parse(doctorRan.stdout) as DoctorReport;
  } catch {
    doctorReport = null;
  }

  if (doctorReport === null) {
    record({
      id: 'doctor',
      state: 'warn',
      detail:
        `${COMMAND} is installed and answers --version, and "${COMMAND} doctor --json" exited ` +
        `${String(doctorRan.code)} without printing a report:\n` +
        trimStderr(`${doctorRan.stdout}\n${doctorRan.stderr}`),
      action: `${COMMAND} doctor`,
      data: { exitCode: doctorRan.code, parsed: false },
    });
  } else {
    const checks = doctorReport.sections.flatMap((section) => section.checks);
    const failed = checks.filter((check) => check.status === 'fail');
    const warned = checks.filter((check) => check.status === 'warn');
    const census =
      `${String(checks.length - failed.length - warned.length)} ok, ` +
      `${String(warned.length)} warn, ${String(failed.length)} fail`;

    record(
      doctorRan.code === 0
        ? {
            id: 'doctor',
            state: 'ok',
            detail:
              `ran "${COMMAND} doctor" through the installed command: ${census}. The F3.4 ` +
              `conformance battery was not run — "${COMMAND} doctor" on its own runs it.`,
            data: { exitCode: doctorRan.code, ok: true, census },
          }
        : {
            id: 'doctor',
            // AC9 — the distinction this row exists to make, in words rather
            // than only in a state: the install worked, the machine has
            // problems, and doctor's own 5 does not become this command's.
            state: 'warn',
            detail:
              `installed correctly, and this machine has problems: "${COMMAND} doctor" exited ` +
              `${String(doctorRan.code)} with ${census}. That is a machine doctor says DeFlow ` +
              'cannot fully run on, not a failed installation — the install is verified above.' +
              (failed.length === 0
                ? ''
                : `\n${failed.map((check) => `  ${check.id}: ${check.detail}`).join('\n')}`),
            action: nextAction(toReport(doctorReport)) ?? `${COMMAND} doctor`,
            data: { exitCode: doctorRan.code, ok: false, census },
          },
    );
  }

  // ---- 5. adapters --------------------------------------------------------

  const resolutions = resolveProviderStates(roots);
  const offered = await offerAdapterInstalls({
    resolutions,
    // AC10 — KAR-18.8's own rules, called rather than restated. `--yes` is a
    // consent for this too: it is the flag that means "do not ask me".
    mode: installMode({ json, fix: options.fix === true || yes, tty }),
    prompt: ask,
    roots,
    clock,
    dataDir,
    env,
  });

  const after = offered.resolutions;
  const installed = after.filter((entry) => entry.state === 'installed');
  const missing = after.filter((entry) => entry.state !== 'installed');

  record({
    id: 'adapters',
    state: missing.some((entry) => entry.state === 'adapter-missing') ? 'warn' : 'ok',
    detail:
      `${String(installed.length)} of ${String(after.length)} providers are ready to route` +
      (installed.length === 0 ? '' : `: ${installed.map((entry) => entry.provider).join(', ')}`) +
      '.' +
      (missing.length === 0
        ? ''
        : `\n${missing.map((entry) => `  ${providerVerdict(entry).detail}`).join('\n')}`) +
      (offered.checks.size === 0
        ? ''
        : `\n${[...offered.checks.values()].map((check) => `  ${check.detail}`).join('\n')}`),
    ...(missing.length === 0
      ? {}
      : { action: `${COMMAND} doctor --fix    # ${installCommand(missing[0]?.package ?? '')}` }),
    data: {
      ready: installed.map((entry) => entry.provider),
      missing: missing.map((entry) => ({ provider: entry.provider, state: entry.state })),
    },
  });

  return finish(steps, style, json);
}

/** The five rows, as one report or as one document. */
function finish(
  steps: ReadonlyMap<SetupStepId, SetupStep>,
  style: Style,
  json: boolean,
): SetupResult {
  const ordered = SETUP_STEPS.map((id) => steps.get(id) as SetupStep);
  const exitCode = exitCodeFor(ordered);

  if (json) {
    return {
      exitCode,
      stdout: `${JSON.stringify(
        {
          command: `${COMMAND} setup`,
          exitCode,
          status: worst(ordered),
          steps: ordered.map((step) => ({
            id: step.id,
            state: step.state,
            detail: step.detail,
            ...(step.data === undefined ? {} : { data: step.data }),
          })),
        },
        null,
        2,
      )}\n`,
      stderr: '',
      steps: ordered,
    };
  }

  const report: Report = {
    title: `${COMMAND} setup`,
    exitCode,
    sections: [
      {
        title: 'Install',
        rows: ordered.map((step) => ({
          id: step.id,
          state: step.state,
          detail: step.detail,
          ...(step.action === undefined ? {} : { action: step.action }),
        })),
      },
    ],
    fallbackAction:
      exitCode === 0
        ? `${COMMAND} doctor    # in a new shell, to see what this machine can do`
        : `${COMMAND} setup --yes`,
  };

  return { exitCode, stdout: renderReport(report, style), stderr: '', steps: ordered };
}

/** The worst state in the report, for the JSON document's own verdict. */
function worst(steps: readonly SetupStep[]): ReportState {
  const severity: Record<ReportState, number> = { ok: 0, skipped: 1, warn: 2, fail: 3 };
  return steps.reduce<ReportState>(
    (found, step) => (severity[step.state] > severity[found] ? step.state : found),
    'ok',
  );
}
