import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/ipc", () => ({ writeSession: vi.fn().mockResolvedValue(undefined) }));

import { broadcastInput } from "../src/broadcast";
import { writeSession } from "../src/ipc";

beforeEach(() => vi.clearAllMocks());

describe("broadcastInput", () => {
  it("writes text + CR to each target session", () => {
    broadcastInput(["a", "b"], "hello");
    expect(writeSession).toHaveBeenCalledTimes(2);
    expect(writeSession).toHaveBeenCalledWith("a", "hello\r");
    expect(writeSession).toHaveBeenCalledWith("b", "hello\r");
  });
  it("is a no-op with no targets", () => {
    broadcastInput([], "x");
    expect(writeSession).not.toHaveBeenCalled();
  });
});
