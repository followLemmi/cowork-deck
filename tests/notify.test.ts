import { describe, it, expect } from "vitest";
import { NotifyRouter } from "../src/notify";

describe("NotifyRouter", () => {
  it("maps notification ids back to sessions", () => {
    const r = new NotifyRouter();
    const id1 = r.register("sess-a");
    const id2 = r.register("sess-b");
    expect(id1).not.toBe(id2);
    expect(r.resolve(id1)).toBe("sess-a");
    expect(r.resolve(id2)).toBe("sess-b");
    expect(r.resolve(9999)).toBeNull();
  });
});
