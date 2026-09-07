import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // This is the vitest config: there is no `vitest.config.ts`, and vitest reads
  // the `test` key here.
  //
  // `css: true` because vitest stubs CSS imports by default, which makes `?raw`
  // on a stylesheet resolve to an empty string — and tests/view-switch.test.ts
  // asserts a computed `display` against the real stylesheet, so it needs the
  // actual bytes.
  //
  // `setupFiles` because the two shims a `TerminalPanel` cannot be built without
  // were copied into eleven test files, identically. What is in it and what is
  // deliberately left out is argued in the file itself (#463).
  test: {
    css: true,
    setupFiles: ["tests/setup/dom-shims.ts"],
  },
  server: {
    port: 1420,
    strictPort: true,
    // Vite watches the project recursively, and inotify spends one watch per
    // directory. src-tauri/target alone is ~20k files after a release build,
    // and every git worktree under .claude/worktrees carries its own copy of
    // node_modules and target — enough to exhaust fs.inotify.max_user_watches
    // and kill `tauri dev` with ENOSPC before the window opens. None of it is
    // frontend source, so none of it needs watching.
    watch: { ignored: ["**/src-tauri/**", "**/.claude/worktrees/**", "**/dist/**"] },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html", tray: "tray.html", workspace: "workspace.html",
      },
    },
  },
});
