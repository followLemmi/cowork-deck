import { writeSession } from "./ipc";
import { sessionRefusal } from "./session-refusal";

/** Send one line of input (with a trailing CR) to each target session.
 *
 *  `catch` rather than a bare `void`: a write is now refused when the session has
 *  ended or when this window no longer owns it, and a broadcast is the one caller
 *  that writes to sessions it is not looking at — so it is the likeliest to hold
 *  an id that has since gone. Neither refusal is worth a console error, and both
 *  would be an unhandled rejection if nobody took them. */
export function broadcastInput(sessions: string[], text: string): void {
  const data = text + "\r";
  for (const s of sessions) {
    writeSession(s, data).catch((e) => {
      if (sessionRefusal(e) === null) console.debug("broadcast write failed", s, e);
    });
  }
}
