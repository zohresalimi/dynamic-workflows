/**
 * @DeFlow/mock-agent — a real, seeded, deterministic ACP *agent* binary:
 * scripted chunks, permission requests, fs/terminal callbacks, hang, mid-turn
 * crash, malformed frames, a 10 MB line and configurable agentCapabilities.
 *
 * It deliberately has zero workspace dependencies. If it depended on
 * @DeFlow/core, a bug in the domain model could be mirrored on both sides of
 * the wire and cancel itself out. It is an independent implementation of the
 * agent side of the same published schema, which is what makes it a useful
 * oracle.
 *
 * EPIC-04 fills this in.
 */
export {};
