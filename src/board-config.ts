import type { BoardConfig, KindId, StepId } from "./ipc";

/** The label for a step, falling back to its id: a card can name a step the
 *  configuration does not know, and it still has to be readable. */
export function stepLabel(cfg: BoardConfig, id: StepId): string {
  return cfg.steps.find((s) => s.id === id)?.label ?? id;
}

/** Empty for a card that does not say — a missing `kind:` is legal, and the
 *  meta row omits the chip rather than inventing one. */
export function kindLabel(cfg: BoardConfig, id: KindId): string {
  if (!id) return "";
  return cfg.kinds.find((k) => k.id === id)?.label ?? id;
}

export function isKnownStep(cfg: BoardConfig, id: StepId): boolean {
  return cfg.steps.some((s) => s.id === id);
}

export function isTerminal(cfg: BoardConfig, id: StepId): boolean {
  return cfg.steps.some((s) => s.id === id && s.terminal === true);
}

/** `null` for the first step and for a step the configuration does not know —
 *  an unknown step has no neighbours, so the card gets no arrows. */
export function stepBefore(cfg: BoardConfig, id: StepId): StepId | null {
  const i = cfg.steps.findIndex((s) => s.id === id);
  return i > 0 ? cfg.steps[i - 1].id : null;
}

export function stepAfter(cfg: BoardConfig, id: StepId): StepId | null {
  const i = cfg.steps.findIndex((s) => s.id === id);
  return i >= 0 && i < cfg.steps.length - 1 ? cfg.steps[i + 1].id : null;
}

export function workingStep(cfg: BoardConfig): StepId | null {
  return cfg.steps.find((s) => s.working === true)?.id ?? null;
}

export function firstTerminal(cfg: BoardConfig): StepId | null {
  return cfg.steps.find((s) => s.terminal === true)?.id ?? null;
}
