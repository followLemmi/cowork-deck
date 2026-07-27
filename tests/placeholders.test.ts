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
    expect(await resolvePrompt("plain", ask)).toBe("plain");
    expect(ask).not.toHaveBeenCalled();
  });
  it("asks and fills when placeholders present", async () => {
    const ask = vi.fn().mockResolvedValue({ branch: "feat/x" });
    expect(await resolvePrompt("on {{branch}}", ask)).toBe("on feat/x");
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
