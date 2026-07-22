import { TerminalPanel } from "./terminal";
import { onOutput } from "./ipc";

const deck = document.querySelector<HTMLElement>("#deck")!;
const mount = document.createElement("div");
mount.className = "panel";
deck.appendChild(mount);

const session = "manual-1";
const panel = new TerminalPanel(session, mount);
onOutput((s, text) => { if (s === session) panel.write(text); });
// Launch in the project root with a trivial prompt to verify interactivity.
panel.start(".", "say hello and wait").catch((e) => console.error(e));
window.addEventListener("resize", () => panel.fit());
