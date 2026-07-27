import { describe, it, expect, vi } from "vitest";
import { runBoot } from "../src/boot";

describe("runBoot", () => {
  it("runs the steps in order", async () => {
    const seen: string[] = [];
    await runBoot({
      steps: [
        async () => { seen.push("a"); },
        async () => { seen.push("b"); },
      ],
      releaseScheduler: async () => { seen.push("scheduler"); },
      onError: () => {},
    });

    expect(seen).toEqual(["a", "b", "scheduler"]);
  });

  // The scheduler loop blocks on this signal. Skipping it because an earlier
  // step threw leaves every schedule dead for the lifetime of the window,
  // while the UI still shows scenarios as scheduled.
  it("releases the scheduler even when a step throws", async () => {
    const releaseScheduler = vi.fn().mockResolvedValue(undefined);
    const later = vi.fn();

    await runBoot({
      steps: [async () => { throw new Error("restore failed"); }, later],
      releaseScheduler,
      onError: () => {},
    });

    expect(releaseScheduler).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  });

  // Previously `void boot()` sent the failure to an unhandled rejection, so a
  // half-booted window looked healthy.
  it("reports the failure instead of swallowing it", async () => {
    const onError = vi.fn();
    const boom = new Error("workspaces failed");

    await runBoot({
      steps: [async () => { throw boom; }],
      releaseScheduler: async () => {},
      onError,
    });

    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("reports a scheduler release that fails on its own", async () => {
    const onError = vi.fn();
    const boom = new Error("ipc down");

    await runBoot({
      steps: [],
      releaseScheduler: async () => { throw boom; },
      onError,
    });

    expect(onError).toHaveBeenCalledWith(boom);
  });
});
