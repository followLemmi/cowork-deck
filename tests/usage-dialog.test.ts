// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import css from "../src/styles.css?raw";
import type { AiUsage, LimitWindow } from "../src/ipc";

const { clearMock } = vi.hoisted(() => ({ clearMock: vi.fn() }));
vi.mock("../src/ipc", () => ({ usageClearObserved: clearMock }));

import { openUsageDialog } from "../src/usage-dialog";

const win = (over: Partial<LimitWindow> = {}): LimitWindow => ({
  id: "session", label: "Current session", usedFraction: null, amount: null,
  resetsAt: null, state: "unknown", source: "unknown", note: null, ...over,
});

const snap = (over: Partial<AiUsage> = {}): AiUsage => ({
  provider: "claude", label: "Claude", account: null, plan: null, windows: [],
  source: "unknown", fetchedAt: 0, error: null, probeCommand: null,
  needsCredential: false, ...over,
});

const NOW = new Date("2026-08-27T13:30:00").getTime();
const RESET = new Date("2026-08-27T19:00:00").getTime();

let opened: string[] = [];
const host = {
  openCommandTile: (_t: string, c: string) => { opened.push(c); },
  cwd: () => "/tmp",
};

beforeEach(() => {
  opened = [];
  clearMock.mockReset().mockResolvedValue(undefined);
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.replaceChildren();
});

const box = () => document.querySelector<HTMLElement>(".lim-screen")!;

describe("the dialog behind a row", () => {
  /** The clause the whole feature is designed around: every window says which
   *  tier its number is on, in the same typeface as the number. */
  it("names the source of every window it shows", () => {
    openUsageDialog(snap({ windows: [
      win({ id: "session", usedFraction: 0.23, state: "ok", source: "reported" }),
      win({ id: "week", label: "Current week", amount: { used: 900, limit: null, unit: "tokens" }, source: "observed" }),
    ] }), host, () => {}, NOW);
    const blocks = [...box().querySelectorAll(".lim-win")];
    expect(blocks.length).toBe(2);
    expect(blocks.map((b) => b.querySelector(".lim-src")!.textContent))
      .toEqual(["Reported", "Observed"]);
    // And what each tier MEANS, which is the sentence a row has no room for.
    expect(blocks[1].querySelector(".lim-win-tier")!.textContent)
      .toContain("sessions it runs");
  });

  /** The caveat is spelled out in words, and it comes from the provider rather
   *  than from a table in the frontend. */
  it("prints the provider's own caveat under the number", () => {
    openUsageDialog(snap({ windows: [win({
      amount: { used: 5, limit: null, unit: "tokens" }, source: "observed",
      note: "Other terminals, other machines and anything run outside this app are not in it.",
    })] }), host, () => {}, NOW);
    expect(box().querySelector(".lim-win-note")!.textContent).toContain("other machines");
  });

  it("says who the account is, where the provider said", () => {
    openUsageDialog(snap({ account: "person@example.com", plan: "team", windows: [win()] }),
      host, () => {}, NOW);
    expect(box().querySelector(".lim-who")!.textContent).toBe("person@example.com · team");
  });

  it("shows an error the person can act on", () => {
    openUsageDialog(snap({ error: "not signed in — run `claude auth login`", windows: [win()] }),
      host, () => {}, NOW);
    expect(box().querySelector(".lim-error")!.textContent).toContain("claude auth login");
  });

  it("runs the provider's own command in a tile when asked", () => {
    openUsageDialog(snap({ probeCommand: 'claude -p "/usage"', windows: [win()] }), host, () => {}, NOW);
    const ask = [...box().querySelectorAll("button")].find((b) => b.textContent === "Ask in a tile")!;
    ask.click();
    expect(opened).toEqual(['claude -p "/usage"']);
  });

  /** The escape hatch: the observed parser can be wrong, and an app insisting
   *  the budget is spent while sessions are plainly running would be worse than
   *  one that never said so. */
  it("offers to forget a refusal, and only where there is one to forget", () => {
    openUsageDialog(snap({ windows: [win({ usedFraction: 0.1, state: "ok" })] }), host, () => {}, NOW);
    expect([...box().querySelectorAll("button")].some((b) => /forget/i.test(b.textContent ?? "")))
      .toBe(false);
    document.body.replaceChildren();

    let changed = 0;
    openUsageDialog(snap({ windows: [win({ state: "exhausted", resetsAt: RESET })] }),
      host, () => { changed += 1; }, NOW);
    const forget = [...box().querySelectorAll("button")].find((b) => /forget/i.test(b.textContent ?? ""))!;
    forget.click();
    return Promise.resolve().then(() => {
      expect(clearMock).toHaveBeenCalledWith("claude");
      expect(changed).toBe(1);
      expect(document.querySelector(".lim-screen")).toBe(null);
    });
  });

  it("says a spent window is spent, with or without a time", () => {
    openUsageDialog(snap({ windows: [win({ state: "exhausted", resetsAt: RESET })] }), host, () => {}, NOW);
    expect(box().querySelector(".lim-win-out")!.textContent).toContain("Spent until");
    document.body.replaceChildren();
    openUsageDialog(snap({ windows: [win({ state: "exhausted", resetsAt: null })] }), host, () => {}, NOW);
    expect(box().querySelector(".lim-win-out")!.textContent).toBe("Spent. No reset time is known.");
  });

  /** A provider whose limits need a credential this app will not take has to say
   *  that, rather than leaving a person to wonder what is broken. */
  it("explains a provider that would need a credential", () => {
    openUsageDialog(snap({ needsCredential: true, windows: [win()] }), host, () => {}, NOW);
    expect(box().querySelector(".lim-hint")!.textContent).toContain("does not take");
  });

  it("draws no meter for a window with no share", () => {
    openUsageDialog(snap({ windows: [win({
      amount: { used: 900, limit: null, unit: "tokens" }, source: "observed",
    })] }), host, () => {}, NOW);
    expect(box().querySelector(".lim-meter")).toBe(null);
    expect(box().querySelector(".lim-win-reading")!.textContent).toBe("900 tokens");
  });

  it("puts text from outside the app in as text", () => {
    openUsageDialog(snap({
      account: "<script>alert(1)</script>",
      windows: [win({ note: "<b>bold</b>" })],
    }), host, () => {}, NOW);
    expect(box().querySelector("script")).toBe(null);
    expect(box().querySelector("b")).toBe(null);
    expect(box().querySelector(".lim-win-note")!.textContent).toBe("<b>bold</b>");
  });

  it("closes on Done and on a click outside the box", () => {
    openUsageDialog(snap({ windows: [win()] }), host, () => {}, NOW);
    [...box().querySelectorAll("button")].find((b) => b.textContent === "Done")!.click();
    expect(document.querySelector(".lim-screen")).toBe(null);

    openUsageDialog(snap({ windows: [win()] }), host, () => {}, NOW);
    const ov = document.querySelector<HTMLElement>(".modal-overlay")!;
    ov.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".lim-screen")).toBe(null);
  });
});
