import { describe, it, expect, vi } from "vitest";
import { parsePlaceholders, fillPlaceholders, resolvePrompt } from "../src/placeholders";

describe("parsePlaceholders", () => {
  it("returns [] when none", () => {
    expect(parsePlaceholders("just a prompt")).toEqual([]);
  });
  it("extracts unique names in order of appearance", () => {
    expect(parsePlaceholders("fix {{ticket}} on {{branch}}, retest {{ticket}}"))
      .toEqual(["ticket", "branch"]);
  });
  it("tolerates inner whitespace", () => {
    expect(parsePlaceholders("{{  branch  }}")).toEqual(["branch"]);
  });
});

describe("fillPlaceholders", () => {
  it("replaces all occurrences", () => {
    expect(fillPlaceholders("{{a}}-{{a}}-{{b}}", { a: "1", b: "2" })).toBe("1-1-2");
  });
  it("leaves unknown placeholders untouched", () => {
    expect(fillPlaceholders("{{a}}/{{b}}", { a: "x" })).toBe("x/{{b}}");
  });
});

describe("resolvePrompt", () => {
  it("returns prompt unchanged and does not ask when no placeholders", async () => {
    const ask = vi.fn();
    expect(await resolvePrompt("plain", ask)).toEqual({ prompt: "plain", params: {} });
    expect(ask).not.toHaveBeenCalled();
  });
  // Both halves come back, and the second one is the point: the run journal
  // records what a run was launched with, so it can be offered again later with
  // those values in front of the person rather than silently reapplied.
  it("asks and fills when placeholders present, and hands back the values", async () => {
    const ask = vi.fn().mockResolvedValue({ branch: "feat/x" });
    expect(await resolvePrompt("on {{branch}}", ask))
      .toEqual({ prompt: "on feat/x", params: { branch: "feat/x" } });
    expect(ask).toHaveBeenCalledWith(["branch"]);
  });
  it("returns null when the user cancels", async () => {
    const ask = vi.fn().mockResolvedValue(null);
    expect(await resolvePrompt("on {{branch}}", ask)).toBeNull();
  });
});

// A prompt is written in whatever language its author thinks in, whatever the
// UI's language is, so placeholder names are not reliably ASCII. `\w` is
// ASCII-only in JavaScript, so {{ветка}} matched nothing: no field was offered
// and the literal braces were sent to claude as part of the prompt.
it("recognises non-ASCII placeholder names", () => {
  expect(parsePlaceholders("Review {{ветка}} and {{задача}}")).toEqual(["ветка", "задача"]);
});

it("substitutes them too", () => {
  expect(fillPlaceholders("Branch {{ветка}}", { "ветка": "main" })).toBe("Branch main");
});
