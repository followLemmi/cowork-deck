/** The two things jsdom does not have that a `TerminalPanel` cannot be built
 *  without, installed once instead of in eleven test files.
 *
 *  Registered as `setupFiles` in `vite.config.ts`, which is where this project's
 *  vitest config lives — there is no `vitest.config.ts`, and there does not need
 *  to be one.
 *
 *  **What is here and what is deliberately not.**
 *
 *  `ResizeObserver` and `window.__TAURI_INTERNALS__` are here because no test can
 *  depend on their absence: the panel's constructor observes its element, and it
 *  builds a real output `Channel` whose constructor registers a handler through
 *  Tauri's injected internals. Both were copied into eleven and ten files
 *  respectively, identically, and a shim that differs by file is a difference
 *  nobody meant (#463).
 *
 *  **`IntersectionObserver` is NOT here, and that is the interesting one.**
 *  `watchVisibility` treats "no IntersectionObserver" as "never on screen", which
 *  is what keeps a unit test from ever asking jsdom for a WebGL context. Its
 *  absence is therefore a fixture in its own right, and installing one globally
 *  would quietly turn the GPU path on across the whole suite. The four files that
 *  want one — two of them a driveable one, so the test can say when a tile is on
 *  screen — install it themselves, next to the reasoning.
 *
 *  Assigned with `??=` throughout: a file that wants a different shim overwrites
 *  it after this runs, and `terminal-write.test.ts` does exactly that with a
 *  `transformCallback` that keeps every registration so it can tell a second
 *  channel from the first.
 */
class InertObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= InertObserver;

// `window` is absent in the `node` environment, which most of this suite runs in.
if (typeof window !== "undefined") {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ??= {
    transformCallback: () => 1,
    unregisterCallback: () => {},
  };
}
