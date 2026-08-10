/**
 * A child that behaves like an interactive agent CLI: it reads commands from
 * its terminal, answers on the terminal, and reports the window size it was
 * given.
 *
 * A real child rather than a fake pty, because every claim KAR-15.8 makes is
 * about the boundary: that bytes typed into a browser reach a process's stdin,
 * that a resize frame arrives as a real `SIGWINCH`, and that closing the panel
 * does not take the process with it. Mocking `@lydell/node-pty` would leave all
 * three untested and every test green.
 *
 * The protocol is line-based because a pty is line-buffered by default, which
 * is exactly what the daemon has to cope with:
 *
 * | Line       | Effect                                                       |
 * | ---------- | ------------------------------------------------------------ |
 * | `echo X`   | writes `echoed X`                                            |
 * | `size`     | writes `size <cols>x<rows>`                                  |
 * | `emit N`   | writes `line 1…N`, one every 40 ms, then `emitted N`         |
 * | `bye [N]`  | exits with code N (default 0)                                |
 *
 * It also writes `size …` unprompted on `SIGWINCH`, which is how the resize
 * assertion observes the child rather than the daemon's own bookkeeping.
 */
import process from 'node:process';

const say = (line: string): void => {
  // `\r\n`, not `\n`: this is a terminal, and a bare newline leaves the cursor
  // in the column it was in — which turns a readable assertion failure into a
  // staircase nobody can read.
  process.stdout.write(`${line}\r\n`);
};

const dimensions = (): string => `size ${process.stdout.columns}x${process.stdout.rows}`;

say('ready');

process.stdout.on('resize', () => say(dimensions()));

let buffered = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffered += chunk;
  for (;;) {
    const breakAt = buffered.search(/[\r\n]/);
    if (breakAt === -1) return;
    const line = buffered.slice(0, breakAt).trim();
    buffered = buffered.slice(breakAt + 1);
    if (line !== '') handle(line);
  }
});

function handle(line: string): void {
  const [verb, argument] = line.split(' ');
  switch (verb) {
    case 'echo':
      say(`echoed ${argument ?? ''}`);
      return;
    case 'size':
      say(dimensions());
      return;
    case 'emit':
      emit(Number(argument ?? '1'));
      return;
    case 'bye':
      process.exit(Number(argument ?? '0'));
      return;
    default:
      say(`unknown ${verb ?? ''}`);
  }
}

function emit(count: number): void {
  let written = 0;
  const step = (): void => {
    written += 1;
    say(`line ${written}`);
    if (written >= count) {
      say(`emitted ${count}`);
      return;
    }
    setTimeout(step, 40);
  };
  step();
}
