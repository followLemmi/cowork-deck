// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { selectedFromChecks } from "../src/sessions";

describe("selectedFromChecks", () => {
  it("returns session ids of checked boxes", () => {
    const checks = [
      { session: "a", checked: true },
      { session: "b", checked: false },
      { session: "c", checked: true },
    ];
    expect(selectedFromChecks(checks)).toEqual(["a", "c"]);
  });
});
