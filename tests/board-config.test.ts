import { describe, it, expect } from "vitest";
import {
  firstTerminal, isKnownKind, isKnownStep, isTerminal, kindLabel, stepAfter, stepBefore, stepLabel, workingStep,
} from "../src/board-config";
import type { BoardConfig } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "Backlog" },
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

describe("board-config readers", () => {
  it("labels a step, falling back to its id when the configuration does not know it", () => {
    expect(stepLabel(CFG, "todo")).toBe("To do");
    // A card can name a step nothing defines, and it still has to be readable.
    expect(stepLabel(CFG, "legacy")).toBe("legacy");
  });

  it("labels a kind, and returns empty for a card that names none", () => {
    expect(kindLabel(CFG, "bug")).toBe("Bug");
    expect(kindLabel(CFG, "chore")).toBe("chore");
    expect(kindLabel(CFG, "")).toBe("");
  });

  it("knows its own steps", () => {
    expect(isKnownStep(CFG, "doing")).toBe(true);
    expect(isKnownStep(CFG, "legacy")).toBe(false);
  });

  it("knows its own kinds", () => {
    expect(isKnownKind(CFG, "bug")).toBe(true);
    expect(isKnownKind(CFG, "chore")).toBe(false);
    // An absent kind is legal (see kindLabel above) but still not "known" —
    // callers that need to tell "empty" from "unknown, non-empty" apart do so
    // themselves, the way card-modal.ts's "(no kind)" option does.
    expect(isKnownKind(CFG, "")).toBe(false);
  });

  it("reports the terminal and working steps", () => {
    expect(isTerminal(CFG, "done")).toBe(true);
    expect(isTerminal(CFG, "todo")).toBe(false);
    expect(firstTerminal(CFG)).toBe("done");
    expect(workingStep(CFG)).toBe("doing");
    expect(workingStep({ ...CFG, steps: CFG.steps.map((s) => ({ ...s, working: false })) })).toBeNull();
  });

  it("walks neighbours and stops at the ends", () => {
    expect(stepBefore(CFG, "todo")).toBe("backlog");
    expect(stepAfter(CFG, "todo")).toBe("doing");
    expect(stepBefore(CFG, "backlog")).toBeNull();
    expect(stepAfter(CFG, "done")).toBeNull();
  });

  it("gives an unknown step no neighbours at all", () => {
    // Which is why a card in the unknown-step column gets no ‹ › arrows.
    expect(stepBefore(CFG, "legacy")).toBeNull();
    expect(stepAfter(CFG, "legacy")).toBeNull();
  });

  it("returns the first terminal step when there are several", () => {
    const two = { ...CFG, steps: [...CFG.steps, { id: "cancelled", label: "Cancelled", terminal: true }] };
    expect(firstTerminal(two)).toBe("done");
    expect(isTerminal(two, "cancelled")).toBe(true);
  });
});
