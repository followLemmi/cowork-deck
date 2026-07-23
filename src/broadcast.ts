import { writeSession } from "./ipc";

/** Send one line of input (with a trailing CR) to each target session. */
export function broadcastInput(sessions: string[], text: string): void {
  const data = text + "\r";
  for (const s of sessions) void writeSession(s, data);
}
