/**
 * mulberry32: 32 bits of state, uniform enough to draw an id from and short
 * enough to read.
 *
 * `@DeFlow/testkit` has the same function, and this is a deliberate copy rather
 * than an import. The mock agent depends on nothing in the workspace — if it
 * shared code with the code it is used to test, a bug in the shared half would
 * be mirrored on both sides of the wire and cancel itself out
 * (docs/16-repo-layout.md §1, docs/07-provider-adapter-layer.md §13).
 *
 * Nothing cryptographic depends on it and nothing should. Its only contract is
 * that the same seed produces the same sequence in every process, which is the
 * whole of AC4.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}
