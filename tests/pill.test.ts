import { describe, it, expect } from "vitest";
import { pillLabel } from "../src/pill-util";

describe("pillLabel", () => {
  it("reads naturally for 1", () => expect(pillLabel(1)).toBe("1 waiting for input"));
  it("reads naturally for 2", () => expect(pillLabel(2)).toBe("2 waiting for input"));
  it("reads naturally for 5", () => expect(pillLabel(5)).toBe("5 waiting for input"));

});
