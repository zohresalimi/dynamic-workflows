/**
 * KAR-26.2 AC1, AC4 / EPIC-26-S09, EPIC-26-S13 — the two composition roots
 * cannot drift apart on machine identity.
 *
 * `boot()` learns which machine it is on only from its caller: `providerRoots`
 * is what admission resolves against and `probeProviders` is what fills the
 * manifest, and both are ports rather than calls inside `boot()` because
 * DeFlowd's own `PATH` at daemon start is not the operator's login-shell one
 * (§4.3). There are exactly two callers that *do* run in an operator's own
 * terminal and may therefore answer: `deflow up` and the daemon `pnpm dev`
 * runs. Until this story only the first passed them, and the daemon a developer
 * actually runs was the one daemon that could not say what the machine has —
 * `known: false` on the picker, no `admit` at all on intake, and a suite that
 * was green in every direction while the app was untestable.
 *
 * The guard is mechanical because the failure is silent. It does not hold a
 * list of option names: it *derives* the machine-identity set from `up.ts`'s
 * own `boot({ ... })` call — the options whose values end up reading this
 * machine — and then requires `main.ts` to pass every one of them, reading its
 * own machine rather than a placeholder. So the next such port added to
 * `up.ts` alone turns this red, naming the option, without anybody remembering
 * to come back here.
 *
 * "End up reading" is traced through the file's own bindings, not matched at
 * the call site, because `providerHome: home` names no environment on the line
 * that passes it and binding the value one line earlier is what an author does
 * as soon as the expression grows. What the tracing rests on is `machineSources`
 * below, and its limits are stated there: the `MACHINE_FACT` vocabulary is
 * finite, and a text scan has no scopes, so lookups are anchored to the nearest
 * declaration above the call.
 *
 * Every check is a pure function over source text handed to it, and every one
 * has a spec that feeds it a violating source and watches it catch it — the
 * same shape as `test/one-live-chain-caller.test.ts`, for the same reason: a
 * scan that has never failed is indistinguishable from a scan that cannot.
 * `the guard bites` is where both blind spots this file has already had are
 * pinned as fixtures.
 *
 * Verifies: EPIC-26-S09, EPIC-26-S10, EPIC-26-S13 · KAR-26.2 AC1, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from './support/workspace.ts';

const UP = 'packages/cli/src/up.ts';
const MAIN = 'packages/daemon/src/main.ts';
const HARNESS = 'packages/daemon/test/integration/dev-daemon-machine-identity.test.ts';

interface BootOption {
  readonly key: string;
  /** The value expression as written, which is what "built from the
   *  environment" is decided on. */
  readonly value: string;
}

/**
 * The rule is about the call, not about the prose.
 *
 * Both files have to write `providerRoots` and `probeProviders` down in comments
 * to explain why they pass them, and a comment passes nothing.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Splits one object literal's top-level entries, starting just past its `{`.
 *
 * Depth-aware rather than a comma split: half of these values are arrow
 * functions over object arguments, and `probeProviders`' body contains four
 * commas that belong to somebody else.
 */
function objectEntries(source: string, start: number): readonly string[] {
  const entries: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quote !== null) {
      current += char;
      if (char === '\\') {
        current += source[index + 1] ?? '';
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') {
      if (char === '}' && depth === 0) {
        entries.push(current);
        break;
      }
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      entries.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * Every option a file's `boot({ ... })` call passes.
 *
 * A conditional spread is descended into rather than skipped: both files use
 * `...(x === undefined ? {} : { key: value })` for options they only sometimes
 * pass, and an option hidden behind one is still passed.
 */
function bootOptions(fileText: string): readonly BootOption[] {
  const source = code(fileText);
  const call = /\bboot\s*\(\s*\{/.exec(source);
  if (call === null) return [];

  const options: BootOption[] = [];
  for (const entry of objectEntries(source, call.index + call[0].length)) {
    if (entry.startsWith('...')) {
      const brace = entry.indexOf('{');
      if (brace !== -1) options.push(...nested(entry, brace));
      continue;
    }
    const named = /^([A-Za-z_$][\w$]*)\s*:([\s\S]*)$/.exec(entry);
    if (named !== null) {
      options.push({ key: named[1] ?? '', value: (named[2] ?? '').trim() });
      continue;
    }
    // Shorthand — `port` in `up.ts`, whose value is the binding of the same
    // name and is therefore the name itself.
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(entry);
    if (shorthand !== null) options.push({ key: shorthand[1] ?? '', value: entry });
  }
  return options;
}

/** Options of every object literal inside a spread entry, at any depth. */
function nested(entry: string, brace: number): readonly BootOption[] {
  const options: BootOption[] = [];
  for (let index = brace; index !== -1; index = entry.indexOf('{', index + 1)) {
    options.push(
      ...objectEntries(entry, index + 1).flatMap((inner) => {
        const named = /^([A-Za-z_$][\w$]*)\s*:([\s\S]*)$/.exec(inner);
        return named === null ? [] : [{ key: named[1] ?? '', value: (named[2] ?? '').trim() }];
      }),
    );
  }
  return options;
}

/**
 * The machine-identity options, recognised by what they are built from rather
 * than by a list of names this file would have to be told about.
 *
 * An option whose value reads this machine — the environment, or the OS asked
 * directly — is an option that answers "which machine is this", and that is
 * precisely the class `boot()` refuses to answer for itself. The CLI's own
 * options do not match and should not: `port` is a number it chose, `onStep` is
 * its timing hook, and `runFraming` is a field of a chain built further up
 * (that chain's *own* env-reading is KAR-19.3's, already wired in both roots).
 */
function machineIdentityOptions(
  options: readonly BootOption[],
  fileText: string,
): readonly BootOption[] {
  return options.filter((option) => machineSources(option.value, fileText).length > 0);
}

/**
 * Reads of this machine that vouch for themselves: the OS asked for a fact
 * about itself, so there is no binding to trace and nothing to fake.
 *
 * This vocabulary is the guard's one remaining blind spot and the place to
 * extend it. `PATH` is how this codebase spells machine identity today, but a
 * future option built from a fact named nowhere here reads as an ordinary
 * value to everything below.
 */
const MACHINE_FACT =
  /\b(?:homedir|hostname|userInfo|tmpdir|cpus|networkInterfaces)\s*\(\s*\)|\bprocess\.(?:platform|arch)\b|\bprocess\.cwd\s*\(\s*\)/g;

/**
 * Every read of this machine a value performs, traced through the file's own
 * bindings to whatever it was ultimately derived from.
 *
 * "What does this end up reading" rather than "does the text say
 * `process.env`", because neither root writes it inline: `up.ts` binds
 * `options.env ?? process.env` so a spec can hand it a staged machine, and
 * `main.ts` binds it once because a bare `env: process.env` at a call site is
 * the shape `packages/daemon/test/no-inline-child-env.test.ts` forbids inside
 * the daemon.
 *
 * Tracing matters more than it looks: `providerHome: home` names no
 * environment on the line that passes it, and binding the value one line
 * earlier is what an author does as soon as the expression grows. A detector
 * that only read the call site would let exactly that drop out of the set.
 *
 * Two things are deliberately *not* followed. An identifier used as a key
 * (`dataDir: dir`) is a name, not a value. And a non-environment identifier
 * read for a property (`chain.runFraming`) is a field of a composed subsystem
 * — `chain` is built from the environment, but plucking a framing port off it
 * is not a machine fact, and following it would drag the whole chain in and
 * stop this guard being about machine identity at all. An identifier that is
 * itself an environment stays a source however it is read, so `env.HOME`
 * counts.
 */
function machineSources(
  value: string,
  fileText: string,
  seen: ReadonlySet<string> = new Set(),
): readonly string[] {
  const found = new Set<string>();
  if (/\bprocess\.env\b/.test(value)) found.add('process.env');
  for (const [fact] of value.matchAll(MACHINE_FACT)) found.add(fact);

  for (const [, name = '', next = ''] of value.matchAll(
    /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\b\s*([:.]?)/g,
  )) {
    if (next === ':') continue;
    if (/env$/i.test(name)) {
      found.add(name);
      continue;
    }
    if (next === '.' || seen.has(name)) continue;
    for (const derived of initializers(fileText, name)) {
      for (const source of machineSources(derived, fileText, new Set([...seen, name]))) {
        found.add(source);
      }
    }
  }
  return [...found];
}

/**
 * What `identifier` was last given before the `boot()` call — the declaration,
 * or a later assignment, since `let port: number;` declares on one line and
 * answers on another.
 *
 * Nearest-above rather than every match in the file, because a text scan has no
 * scopes and `up.ts` binds the name `port` three times in three functions. Read
 * naively, a helper's local would stand in for the value the call site actually
 * passes, and `port` — a number the CLI chose — would arrive here wearing the
 * environment some unrelated function read.
 *
 * Bounded at the statement rather than the line so a call spread over several
 * lines is still read, and capped so a missing `;` cannot swallow the file.
 */
function initializers(fileText: string, identifier: string): readonly string[] {
  const source = code(fileText);
  const call = /\bboot\s*\(\s*\{/.exec(source);
  const before = call === null ? source.length : call.index;
  const pattern = new RegExp(
    `\\b${identifier}\\b\\s*(?::[^=;\\n(){}]{0,80})?=(?![=>])\\s*([^;]{0,400})`,
    'g',
  );
  const nearest = [...source.matchAll(pattern)]
    .filter((match) => (match.index ?? 0) < before)
    .at(-1);
  return nearest === undefined ? [] : [nearest[1] ?? ''];
}

/** Whether a source really describes the machine this process is on — the half
 *  of the claim a name alone cannot carry. A fact read is this machine by
 *  construction; an environment has to be traced back to `process.env`, or a
 *  root that split a hand-made `PATH` would pass a name-only check and describe
 *  a machine nobody is sitting at. */
function readsThisMachine(fileText: string, source: string): boolean {
  if (source === 'process.env') return true;
  if (new RegExp(MACHINE_FACT.source).test(source)) return true;
  const binding = new RegExp(
    `\\b(?:const|let)\\s+${source}\\b[^=\\n]*=\\s*[^;\\n]*process\\.env\\b`,
  );
  return binding.test(code(fileText));
}

/**
 * A value reduced to its construction: what it calls, and the argument names it
 * passes. Blind to the identifiers those arguments are bound to, which is the
 * one thing a staged-`PATH` harness is supposed to change.
 */
function valueShape(value: string): readonly string[] {
  const callees = [...value.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(([, name]) => `${name}()`);
  const keys: string[] = [];
  for (let at = value.indexOf('{'); at !== -1; at = value.indexOf('{', at + 1)) {
    for (const entry of objectEntries(value, at + 1)) {
      const named = /^([A-Za-z_$][\w$]*)/.exec(entry);
      if (named !== null) keys.push(`${named[1]}:`);
    }
  }
  return [...new Set([...callees, ...keys])].toSorted();
}

/** Contiguous runs of `//` lines, and each block comment, as single strings —
 *  so "the comment that carries the justification" is something this file can
 *  point at rather than a search over the whole source. */
function commentBlocks(fileText: string): readonly string[] {
  const blocks = [...fileText.matchAll(/\/\*[\s\S]*?\*\//g)].map(([block]) => block);
  let run: string[] = [];
  for (const line of fileText.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
      run.push(trimmed);
      continue;
    }
    if (run.length > 0) {
      blocks.push(run.join('\n'));
      run = [];
    }
  }
  if (run.length > 0) blocks.push(run.join('\n'));
  return blocks;
}

const up = readText(UP);
const main = readText(MAIN);
const upOptions = machineIdentityOptions(bootOptions(up), up);
const mainOptions = bootOptions(main);

suite('the scan reads both composition roots, so an agreement means something', () => {
  it('finds a boot call in each, with more than the machine-identity options in it', () => {
    expect(bootOptions(up).length).toBeGreaterThan(upOptions.length);
    expect(mainOptions.length).toBeGreaterThan(0);
  });

  it("recognises today's machine-derived options in up.ts", () => {
    // Not the assertion that does the work — that one is derived below — but
    // the one that fails loudly if the regexes stop matching real source and
    // the derived set silently empties. It is also the backstop against the
    // opposite failure: a detector broadened until it matches everything is a
    // detector that has stopped discriminating, and this list is where that
    // shows up.
    //
    // `dataDir` is in the set on its merits — `resolveDataDir(env)` is a read
    // of the operator's environment — even though it is not a *provider* fact.
    // That is the honest consequence of deriving the class instead of listing
    // it, and both roots do have to answer for it.
    expect(upOptions.map((option) => option.key).toSorted()).toEqual([
      'dataDir',
      'probeProviders',
      'providerRoots',
    ]);
  });

  it('leaves the CLI-only options out of the machine-identity set', () => {
    const keys = upOptions.map((option) => option.key);
    for (const cliOnly of ['port', 'dev', 'onStep', 'runFraming', 'advanceRun', 'executeNodes']) {
      expect(keys).not.toContain(cliOnly);
    }
  });
});

suite('EPIC-26-S13 — every machine-identity option up.ts passes, main.ts passes too', () => {
  for (const option of upOptions) {
    it(`passes ${option.key} to boot()`, () => {
      expect(mainOptions.map((passed) => passed.key)).toContain(option.key);
    });
  }
});

suite('EPIC-26-S09 — and main.ts builds each of them from process.env', () => {
  for (const option of upOptions) {
    it(`builds ${option.key} from the environment rather than a placeholder`, () => {
      const passed = mainOptions.find((candidate) => candidate.key === option.key);
      const sources = machineSources(passed?.value ?? '', main);
      expect(sources.length, `${option.key} reads no machine in ${MAIN}`).toBeGreaterThan(0);
      for (const source of sources) {
        expect(readsThisMachine(main, source), `${source} is not this machine`).toBe(true);
      }
    });
  }

  it('extends the operator-terminal justification to the boot options, once', () => {
    // AC1 — `main.ts` already argues that reading `PATH` is correct *here* and
    // nowhere else, for the chain. The boot options are the same argument, so
    // it is extended rather than restated: a second copy is a second place for
    // the two to disagree.
    //
    // Counting the phrase is only the "not duplicated" half, and on its own it
    // is a test that cannot fail — the phrase predates this story, so it stands
    // at 1 whether or not the boot options were ever wired. The half that bites
    // is that the comment carrying it also answers for *these* ports.
    expect(main.split('own terminal').length - 1).toBe(1);
    const justification = commentBlocks(main).find((block) => block.includes('own terminal'));
    expect(justification, 'no comment in main.ts carries the justification').toBeDefined();
    expect(justification ?? '').toContain('KAR-26.2');
  });
});

suite('EPIC-26-S10 — the integration harness boots the shape main.ts boots', () => {
  // `dev-daemon-machine-identity.test.ts` cannot run `main.ts`: it is a
  // side-effecting entry point that binds a port and resolves the author's own
  // `PATH`. So it reconstructs the option pair over a staged `PATH`, and that
  // reconstruction is a copy — a copy that could drift from what `main.ts`
  // actually passes while both suites stayed green, which would leave AC2/AC3
  // proving something about the harness rather than about the daemon.
  //
  // What this pins is the *shape*: same callees, same argument names. What it
  // deliberately does not pin is the environment itself — staging a `PATH` is
  // the whole point of the harness — nor `dataDir`, which is a temp dir there
  // and the operator's data directory in `main.ts`.
  const harness = bootOptions(readText(HARNESS));

  it('passes the provider ports at all', () => {
    const keys = harness.map((option) => option.key);
    expect(keys).toContain('providerRoots');
    expect(keys).toContain('probeProviders');
  });

  for (const key of ['providerRoots', 'probeProviders']) {
    it(`builds ${key} the way main.ts builds it`, () => {
      const inMain = mainOptions.find((option) => option.key === key);
      const inHarness = harness.find((option) => option.key === key);
      expect(valueShape(inHarness?.value ?? '')).toEqual(valueShape(inMain?.value ?? ''));
    });
  }
});

suite('the guard bites', () => {
  const call = (body: string): string => `const started = await boot({\n${body}\n});\n`;

  it('catches a machine-identity option added to up.ts alone', () => {
    const source = call('  dataDir,\n  providerBinaries: binariesOn(env),\n');
    const grown = machineIdentityOptions(bootOptions(source), source);
    expect(grown.map((option) => option.key)).toContain('providerBinaries');
    expect(bootOptions(call('  dataDir,\n')).map((option) => option.key)).not.toContain(
      'providerBinaries',
    );
  });

  it('catches a placeholder that names the option without reading the machine', () => {
    const source = call('  providerRoots: [],\n');
    const placeholder = bootOptions(source).find((option) => option.key === 'providerRoots');
    expect(machineSources(placeholder?.value ?? '', source)).toEqual([]);
  });

  it('catches an environment that is not this process own, however it is named', () => {
    // The bound form has to be traced rather than trusted: a root that split a
    // hand-made `PATH` would pass a name-only check and describe a machine
    // nobody is sitting at.
    const invented = 'const fakeEnv = { PATH: "/opt/bin" };\n';
    expect(machineSources('pathRoots(fakeEnv)', invented)).toEqual(['fakeEnv']);
    expect(readsThisMachine(invented, 'fakeEnv')).toBe(false);
    expect(readsThisMachine('const daemonEnv = process.env;\n', 'daemonEnv')).toBe(true);
  });

  it('is not fooled by an arrow function whose body has commas of its own', () => {
    const options = bootOptions(
      call(
        '  probeProviders: ({ db, dataDir: dir }) =>\n' +
          '    probeProvidersOnBoot({ db, clock, dataDir: dir, env, randomHex }),\n' +
          '  allowNonLoopback: false,\n',
      ),
    );
    expect(options.map((option) => option.key)).toEqual(['probeProviders', 'allowNonLoopback']);
  });

  it('descends into a conditional spread rather than losing what it hides', () => {
    const source = call(
      '  ...(x === undefined ? {} : { providerRoots: pathRoots(process.env) }),\n',
    );
    const options = bootOptions(source);
    expect(options.map((option) => option.key)).toEqual(['providerRoots']);
    expect(machineIdentityOptions(options, source).map((option) => option.key)).toEqual([
      'providerRoots',
    ]);
  });

  it('reads the call and not the comment that explains it', () => {
    const prose = `// providerRoots: pathRoots(env) — passed by up.ts, not here.\n${call('  dataDir,\n')}`;
    expect(bootOptions(prose).map((option) => option.key)).toEqual(['dataDir']);
  });

  it('follows a binding to the environment it was derived from', () => {
    // The shape the first cut of this guard was blind to, and the reason it is
    // worth a spec of its own: `providerHome: home` says nothing about an
    // environment on the line that passes it, and an author who binds the value
    // one line earlier — which is the idiomatic thing to do once the expression
    // grows — would have dropped out of the machine-identity set entirely.
    const source = `const home = env.HOME ?? '';\n${call('  dataDir,\n  providerHome: home,\n')}`;
    const grown = machineIdentityOptions(bootOptions(source), source);
    expect(grown.map((option) => option.key)).toContain('providerHome');
    expect(machineSources('home', source)).toEqual(['env']);
  });

  it('recognises a machine fact that is not an environment read', () => {
    // `PATH` is how this codebase spells "which machine is this" today, but it
    // is not the only spelling, and a guard that only knows the current one
    // would wave through the first option that asks the OS directly.
    const source = call('  machineHome: homeRoots(homedir()),\n');
    const grown = machineIdentityOptions(bootOptions(source), source);
    expect(grown.map((option) => option.key)).toContain('machineHome');
    expect(readsThisMachine(source, 'homedir()')).toBe(true);
  });

  it('does not follow a property plucked off a composed object', () => {
    // The other side of the same knob. `chain` is built from the environment,
    // but `runFraming` is a field of a subsystem rather than a machine fact —
    // KAR-19.3 wired it in both roots and it is not this guard's business. A
    // detector that followed it would drag the whole chain in and stop being
    // about machine identity at all.
    const source =
      'const chain = createLiveRunChain({ providerRoots: pathRoots(env), daemonEnv: env });\n' +
      call('  runFraming: chain.runFraming,\n');
    expect(machineIdentityOptions(bootOptions(source), source).map((o) => o.key)).toEqual([]);
  });
});
