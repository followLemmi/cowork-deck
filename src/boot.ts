// Startup sequence, kept out of main.ts so it can be tested.
//
// The one rule worth encoding: the backend scheduler loop is parked on
// `scheduler_ready` until the frontend releases it, so that signal has to be
// sent whatever else happens during boot. Sending it last inside a plain
// `void boot()` meant any earlier failure — a bad layout file, an IPC hiccup —
// left every schedule dead for the lifetime of the window, with a UI that
// still cheerfully showed scenarios as scheduled.

export interface BootPlan {
  /** Run in order; the first failure stops the rest. */
  steps: Array<() => Promise<void> | void>;
  /** Always sent, success or failure. */
  releaseScheduler: () => Promise<void>;
  onError: (e: unknown) => void;
}

export async function runBoot({ steps, releaseScheduler, onError }: BootPlan): Promise<void> {
  try {
    for (const step of steps) await step();
  } catch (e) {
    onError(e);
  } finally {
    try {
      await releaseScheduler();
    } catch (e) {
      onError(e);
    }
  }
}
