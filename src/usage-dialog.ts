/** The detail behind one row of the limits block — and, first-class rather than
 *  as a footnote, **where each number came from**.
 *
 *  That is the reason this dialog exists at all. A percentage the provider
 *  vouches for and a percentage this app inferred from watching its own terminals
 *  are different claims, and a one-line row has no room to say how they differ.
 *  So every window here carries its tier, what that tier means, and the
 *  provider's own caveat about the number underneath it (ADR-0007).
 *
 *  Shaped like `github-screen.ts`, and it borrows that file's one hard rule:
 *  everything reaches the DOM through `textContent`. Account names, plans, error
 *  text and the quoted terminal banner all come from outside this app.
 */

import type { AiUsage, LimitWindow } from "./ipc";
import { usageClearObserved } from "./ipc";
import {
  formatReset,
  readingOf,
  sourceExplanation,
  sourceLabel,
  stateClass,
  meterFraction,
} from "./usage";

export interface UsageDialogHost {
  openCommandTile(titleText: string, command: string, cwd: string): void | Promise<void>;
  cwd(): string;
}

function para(text: string, cls: string): HTMLElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

function windowBlock(w: LimitWindow, now: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "lim-win";
  box.dataset.window = w.id;
  box.dataset.state = w.state;

  const head = document.createElement("div");
  head.className = "lim-win-head";
  const name = document.createElement("span");
  name.className = "lim-win-name";
  name.textContent = w.label;
  const tier = document.createElement("span");
  // The tier, on every window, always. This is the clause the feature was
  // designed around: printing a reported number and an observed one in the same
  // typeface with no label is the failure mode.
  tier.className = `lim-src lim-src--${w.source}`;
  tier.textContent = sourceLabel(w.source);
  head.append(name, tier);
  box.append(head);

  const reading = document.createElement("p");
  reading.className = "lim-win-reading";
  reading.textContent = readingOf(w);
  box.append(reading);

  const fill = meterFraction(w);
  if (fill !== null) {
    const meter = document.createElement("div");
    meter.className = `lim-meter ${stateClass(w.state)}`;
    const bar = document.createElement("span");
    bar.className = "lim-fill";
    bar.style.width = `${Math.round(fill * 100)}%`;
    meter.append(bar);
    box.append(meter);
  }

  if (w.state === "exhausted") {
    box.append(
      para(
        w.resetsAt === null
          ? "Spent. No reset time is known."
          : `Spent until ${formatReset(w.resetsAt, now)}.`,
        "lim-win-out",
      ),
    );
  } else if (w.resetsAt !== null) {
    box.append(para(`Resets ${formatReset(w.resetsAt, now)}.`, "lim-win-reset"));
  }

  // What the tier means, then what the provider says about this particular
  // number. Two sentences because they answer two questions, and the second is
  // where "other terminals and other machines are not in this" lives.
  box.append(para(sourceExplanation(w.source), "lim-win-tier"));
  if (w.note) box.append(para(w.note, "lim-win-note"));
  return box;
}

/** Open the dialog for one AI.
 *
 *  `onChanged` is called when something in here has altered what the block should
 *  say — today only "forget the refusals", which is the escape hatch the observed
 *  source needs: a parser can be wrong, and an app insisting the budget is spent
 *  while sessions are plainly running would be worse than one that never said so.
 */
export function openUsageDialog(
  snap: AiUsage,
  host: UsageDialogHost,
  onChanged: () => void,
  now = Date.now(),
): void {
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box lim-screen";
  ov.append(box);
  document.body.append(ov);

  const close = () => ov.remove();
  ov.addEventListener("mousedown", (e) => {
    if (e.target === ov) close();
  });

  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = snap.label;
  box.append(title);

  // Who this is about. A plan and an account are the two facts that explain an
  // unexpected ceiling, and neither is guessable from the numbers.
  const who = [snap.account, snap.plan].filter(Boolean).join(" · ");
  if (who) box.append(para(who, "lim-who"));
  if (snap.error) box.append(para(snap.error, "lim-error"));

  for (const w of snap.windows) box.append(windowBlock(w, now));

  if (snap.needsCredential) {
    box.append(
      para(
        "Reading this would need this AI's own credential, which this app does not " +
          "take. Its own session view is where these numbers can be seen.",
        "lim-hint",
      ),
    );
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  if (snap.probeCommand) {
    const ask = document.createElement("button");
    ask.className = "modal-cancel";
    ask.textContent = "Ask in a tile";
    ask.title = `Run ${snap.probeCommand} in a tile`;
    ask.onclick = () => {
      void host.openCommandTile(`${snap.label}: limits`, snap.probeCommand!, host.cwd());
      close();
    };
    actions.append(ask);
  }

  // Offered only where there is something to forget: a refusal this app watched.
  // A button that clears nothing is a button that teaches somebody to distrust
  // the row.
  if (snap.windows.some((w) => w.state === "exhausted")) {
    const forget = document.createElement("button");
    forget.className = "modal-cancel";
    forget.textContent = "It is working — forget this";
    forget.onclick = () => {
      void usageClearObserved(snap.provider)
        .then(() => {
          onChanged();
          close();
        })
        .catch((e) => console.error("usage: could not clear the observed limit", e));
    };
    actions.append(forget);
  }

  const done = document.createElement("button");
  done.className = "modal-ok";
  done.textContent = "Done";
  done.onclick = close;
  actions.append(done);
  box.append(actions);
}
