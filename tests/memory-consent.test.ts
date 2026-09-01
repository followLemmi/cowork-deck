// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  askCapture, askWorthPutting, captureCostNotice, captureQuestion, decideCapture,
} from "../src/memory-consent";

/* The decision is the half worth testing hardest: a question asked at the wrong
   moment is not a smaller fault than a missing one. Capture spends the person's
   own money, so "when do we not ask" and "when do we not act" carry the weight. */
describe("deciding whether a closing session gets a note", () => {
  it("asks when nobody has answered yet", () => {
    expect(decideCapture(undefined)).toEqual({ action: "ask" });
  });

  it("writes without asking once the answer is yes", () => {
    expect(decideCapture(true)).toEqual({ action: "capture" });
  });

  it("writes nothing and says nothing once the answer is no", () => {
    expect(decideCapture(false)).toEqual({ action: "skip" });
  });

  /* The rule knows nothing about whether a note is *possible*, and that is the
     design: folding it in would have meant a round trip on every close,
     including the closes of people who have already said no. */
  it("does not depend on whether a note is possible", () => {
    expect(decideCapture(false)).toEqual({ action: "skip" });
    expect(decideCapture(true)).toEqual({ action: "capture" });
  });
});

/* The guard on the path that is about to open a dialog. A question about
   spending money on something that cannot work is worse than no offer at all. */
describe("whether the question is worth putting", () => {
  it("asks when a note is possible", () => {
    expect(askWorthPutting({ available: true })).toEqual({ action: "ask" });
  });

  it("stays quiet when it is not, and carries the reason for the log", () => {
    const offer = { available: false, reason: "Notes are not available for copilot sessions." };
    expect(askWorthPutting(offer)).toEqual({ action: "skip", reason: offer.reason });
  });
});

/* The copy is a requirement rather than a preference: a person who finds out
   from an invoice was not asked. These assert the substance, not the wording —
   what is sent, whose account it runs on, and that it costs. */
describe("what the question says", () => {
  it("names the session it is about", () => {
    expect(captureQuestion("relay · triage")).toContain("relay · triage");
  });

  it("says what is sent, whose account pays, and that it spends", () => {
    const notice = captureCostNotice().toLowerCase();
    expect(notice).toContain("transcript");
    expect(notice).toContain("your own claude account");
    expect(notice).toMatch(/spends|budget/);
  });

  it("says where the note ends up, because that is the half being bought", () => {
    expect(captureCostNotice().toLowerCase()).toContain("this machine");
  });
});

describe("the dialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const box = () => document.querySelector(".modal-box") as HTMLElement;
  const button = (label: string) =>
    [...box().querySelectorAll("button")].find((b) => b.textContent === label)!;
  const remember = () =>
    box().querySelector('[data-fk="capture-remember"]') as HTMLInputElement;

  it("puts the cost above the buttons, not under them", () => {
    void askCapture("relay");
    const kids = [...box().children];
    const cost = kids.findIndex((k) => k.textContent === captureCostNotice());
    const actions = kids.findIndex((k) => k.classList.contains("modal-actions"));
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(cost).toBeLessThan(actions);
  });

  /* The default click is the harmless one. Enter still accepts — `dialog-shell`
     owns that — so this costs the keyboard nothing. */
  it("gives focus to the refusal rather than to the button that spends money", () => {
    void askCapture("relay");
    expect(document.activeElement).toBe(button("No note"));
  });

  it("resolves yes, and remembers only when asked to", async () => {
    const first = askCapture("relay");
    button("Write the note").click();
    expect(await first).toEqual({ capture: true, remember: false });

    const second = askCapture("relay");
    remember().checked = true;
    remember().dispatchEvent(new Event("change"));
    button("Write the note").click();
    expect(await second).toEqual({ capture: true, remember: true });
  });

  it("resolves no, and a refusal can be remembered too", async () => {
    const first = askCapture("relay");
    button("No note").click();
    expect(await first).toEqual({ capture: false, remember: false });

    const second = askCapture("relay");
    remember().checked = true;
    remember().dispatchEvent(new Event("change"));
    button("No note").click();
    expect(await second).toEqual({ capture: false, remember: true });
  });

  /* Dismissing is a complete answer and a temporary one: it means no this time,
     and it must not be taken as having opted out for good. */
  it("treats Escape as an unremembered no", async () => {
    const answer = askCapture("relay");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await answer).toEqual({ capture: false, remember: false });
  });

  it("closes itself, whichever way it was answered", async () => {
    const answer = askCapture("relay");
    button("No note").click();
    await answer;
    expect(document.querySelector(".modal-box")).toBeNull();
  });
});
