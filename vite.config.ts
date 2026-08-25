import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // Vitest stubs CSS imports by default, which makes `?raw` on a stylesheet
  // resolve to an empty string. tests/view-switch.test.ts asserts a computed
  // `display` against the real stylesheet, so it needs the actual bytes.
  test: { css: true },
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
      input: { main: "index.html", pill: "pill.html", workspace: "workspace.html" },
    },
  },
});
