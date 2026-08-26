/** Rust's refusal of a write or a resize, and how to read it.
 *
 *  Its own module rather than a corner of `ipc.ts`, and for two reasons that
 *  point the same way. It contains no IPC — it is a pure function of a rejected
 *  promise's value — and `ipc.ts` is mocked wholesale by a dozen test files, so
 *  anything living there is absent from every one of them unless each mock is
 *  taught about it. A decision that has to be right on every keystroke should
 *  not depend on a dozen mocks staying in step. The same reasoning as
 *  `window-role.ts` beside it.
 */
/** Rust's two refusals for a write or a resize, as they arrive here.
 *
 *  Both used to be silent successes, and that silence is what made a window with
 *  a session it no longer owns unable to detect itself: it wrote into nothing and
 *  was told nothing. They are two rather than one because the answers are
 *  opposite — see `sessionRefusal`. The literals are the interface;
 *  `src-tauri/src/ownership.rs` carries the same pair. */
export const SESSION_NOT_OWNER = "not-owner";
export const SESSION_GONE = "no-session";
export type SessionRefusal = typeof SESSION_NOT_OWNER | typeof SESSION_GONE;

/** Which refusal a rejected `writeSession`/`resizeSession` carries, if either.
 *
 *  - `not-owner` — this window is stale. The answer is to give up the session,
 *    not to report anything: somebody else is rendering it now.
 *  - `no-session` — the session is gone. A keystroke or a held resize arriving
 *    just after a close does this, and it is ordinary.
 *  - `null` — something else went wrong, and that is worth saying out loud.
 *
 *  A pure function of the rejection so it can be tested without an IPC boundary,
 *  which is the shape this codebase already uses wherever a decision has to be
 *  checked but the surface around it cannot be stood up in jsdom. */
export function sessionRefusal(e: unknown): SessionRefusal | null {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : null;
  if (text === SESSION_NOT_OWNER) return SESSION_NOT_OWNER;
  if (text === SESSION_GONE) return SESSION_GONE;
  return null;
}
