import { describe, it, expect } from "vitest";
import { pillLabel } from "../src/pill-util";

describe("pillLabel", () => {
  it("singular for 1", () => expect(pillLabel(1)).toBe("1 ждёт ввода"));
  it("plural for 2", () => expect(pillLabel(2)).toBe("2 ждут ввода"));
  it("plural for 5", () => expect(pillLabel(5)).toBe("5 ждут ввода"));
  it("singular for 21", () => expect(pillLabel(21)).toBe("21 ждёт ввода"));
  it("plural for 11 (teen exception)", () => expect(pillLabel(11)).toBe("11 ждут ввода"));
});
