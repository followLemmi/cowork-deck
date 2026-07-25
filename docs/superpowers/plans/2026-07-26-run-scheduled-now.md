# Run Scheduled Scenario Now — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a scenario with an enabled schedule a ⏰ button that runs it immediately exactly as the schedule would, without touching the schedule itself.

**Architecture:** Frontend-only. The scheduled fire path already exists (`handleScheduledFire` → `Deck.launchScheduled`), so the button reuses it; `lastRun` cannot shift because only the Rust scheduler loop writes `schedule_state.json` and Rust is untouched. Workspace-resolution rules move out of `main.ts` into a pure helper so they get test coverage, and `handleScheduledFire` starts returning an outcome so a user-initiated run can report failure in a modal instead of the console.

**Tech Stack:** vanilla TypeScript, vitest (jsdom for DOM tests). No Rust changes, no new dependencies.

## Global Constraints
- Tauri v2, Rust core + vanilla TypeScript + xterm.js. **Vanilla TS only, no frameworks.**
- Memory target < 100 MB; lightweight deps only. This feature adds **no** dependency.
- Dark theme, One Dark palette, tokens from `styles.css` `:root`. Animations only on `transform`/`opacity` (ADR-008).
- UI strings in Russian, existing style.
- Test commands unchanged: `npm test` (vitest run), `cargo test --manifest-path src-tauri/Cargo.toml`. Do not break existing tests (126 vitest / 29 cargo at the start of this plan). `npx tsc --noEmit` clean.
- Conventional Commits.
- Webview has no `prompt/confirm/alert` — use `src/modal.ts` (`alertModal`).

## Key decisions (from spec)
- A manual run **does not** affect the schedule: `lastRun` untouched, the regular occurrence still fires.
- The manual run goes through the **same** path as a scheduled fire: placeholder defaults (no questions), `⏰ icon name` tile title, overlap guard.
- The ⏰ **indicator becomes the button** — no two ⏰ per row. The tooltip (rule + next run) moves onto the button.
- A click that does not launch shows `alertModal`; a scheduled fire keeps logging to console.

## File Structure
- **Modify** `src/schedule.ts` — add pure `resolveScheduledWorkspace`.
- **Modify** `src/main.ts` — `handleScheduledFire` returns a `FireOutcome`; wire the 4th `SkillsPanel` callback with modal feedback.
- **Modify** `src/skills.ts` — 4th constructor callback; replace the `.sk-sched` span with a `.sk-now` button.
- **Modify** `src/styles.css` — `.sk-now` style; drop `.sk-sched`.
- **Modify** `tests/schedule.test.ts` — cover the four resolution rules.
- **Modify** `tests/skills.test.ts` — cover the button (presence, callback, tooltip, absence of `.sk-sched`).

---

### Task 1: Pure workspace resolution in `src/schedule.ts`

**Files:**
- Modify: `src/schedule.ts` (add import of `Skill`/`Workspace` types + the function at the end)
- Test: `tests/schedule.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `Skill`, `Workspace` from `./ipc` (both already exported).
- Produces: `resolveScheduledWorkspace(skill: Skill, all: Workspace[], active: Workspace | null) => { ok: true; workspace: Workspace } | { ok: false; reason: "no-workspace" }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/schedule.test.ts`:

```ts
describe("resolveScheduledWorkspace", () => {
  const wsA: Workspace = { id: "a", name: "A", path: "/a", color: "#61afef" };
  const wsB: Workspace = { id: "b", name: "B", path: "/b", color: "#98c379" };
  const skill = (workspaceId: string | null): Skill =>
    ({ id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId });

  it("uses the workspace the scenario is pinned to", () => {
    const r = resolveScheduledWorkspace(skill("b"), [wsA, wsB], wsA);
    expect(r).toEqual({ ok: true, workspace: wsB });
  });
  it("falls back to the active workspace when the scenario is not pinned", () => {
    const r = resolveScheduledWorkspace(skill(null), [wsA, wsB], wsA);
    expect(r).toEqual({ ok: true, workspace: wsA });
  });
  it("refuses when the pinned workspace was deleted", () => {
    const r = resolveScheduledWorkspace(skill("gone"), [wsA, wsB], wsA);
    expect(r).toEqual({ ok: false, reason: "no-workspace" });
  });
  it("refuses when not pinned and there is no active workspace", () => {
    const r = resolveScheduledWorkspace(skill(null), [wsA], null);
    expect(r).toEqual({ ok: false, reason: "no-workspace" });
  });
});
```

Extend the existing import line at the top of the file so the new symbol and
types are available (the file currently imports only the five helpers):

```ts
import {
  describeSchedule, nextRun, nextRunLabel, validateSchedule, shouldSkipOverlap,
  resolveScheduledWorkspace,
} from "../src/schedule";
import type { Skill, Workspace } from "../src/ipc";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schedule.test.ts`
Expected: FAIL — `resolveScheduledWorkspace` is not exported from `../src/schedule`.

- [ ] **Step 3: Implement the helper**

In `src/schedule.ts`, extend the existing type import on line 1 and append the
function at the end of the file:

```ts
import type { Schedule, SchedulePreset, SessionState, Skill, Workspace } from "./ipc";
```

```ts
export type WorkspaceResolution =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "no-workspace" };

/** Where a scheduled run of `skill` should happen. A scenario pinned to a
 *  workspace runs there; an unpinned one runs in the active workspace (as a
 *  manual launch would). A pinned workspace that no longer exists refuses
 *  rather than running the prompt in the wrong folder. */
export function resolveScheduledWorkspace(
  skill: Skill,
  all: Workspace[],
  active: Workspace | null,
): WorkspaceResolution {
  const ws = skill.workspaceId
    ? all.find((w) => w.id === skill.workspaceId) ?? null
    : active;
  return ws ? { ok: true, workspace: ws } : { ok: false, reason: "no-workspace" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/schedule.test.ts`
Expected: PASS (19 tests — 15 existing + 4 new).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS, no type errors — 130 vitest tests (126 at plan start + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/schedule.ts tests/schedule.test.ts
git commit -m "refactor(#9): extract resolveScheduledWorkspace as a tested pure helper"
```

---

### Task 2: `handleScheduledFire` returns an outcome

**Files:**
- Modify: `src/main.ts` (the `handleScheduledFire` function and the `onScheduledFire` listener call)

**Interfaces:**
- Consumes: `resolveScheduledWorkspace` (Task 1).
- Produces: `type FireOutcome = "launched" | "skipped-overlap" | "no-workspace" | "not-scheduled"`; `handleScheduledFire(skillId: string) => Promise<FireOutcome>`. Task 3's UI callback consumes this return value.

- [ ] **Step 1: Extend the imports in `src/main.ts`**

The file currently has `import { resolvePrompt, fillPlaceholders } from "./placeholders";`
and `import { alertModal } from "./modal";`. Add the schedule helper:

```ts
import { resolveScheduledWorkspace } from "./schedule";
```

- [ ] **Step 2: Replace `handleScheduledFire` with the outcome-returning version**

Replace the whole existing function (currently ends with `await deck.launchScheduled(ws, skill, filled);`) with:

```ts
/** Why a scheduled fire did or did not produce a run. The backend-driven path
 *  only logs it; a user-initiated run surfaces it in a modal. */
type FireOutcome = "launched" | "skipped-overlap" | "no-workspace" | "not-scheduled";

/** A scheduled scenario came due (from the backend scheduler or from the ⏰
 *  button): resolve it to a scenario + workspace, fill placeholder defaults (a
 *  scheduled run cannot ask) and launch it as a fresh tile. */
async function handleScheduledFire(skillId: string): Promise<FireOutcome> {
  const skill = skills.find(skillId);
  if (!skill?.schedule?.enabled) return "not-scheduled";
  const res = resolveScheduledWorkspace(skill, workspaces.all, workspaces.active);
  if (!res.ok) return res.reason;
  const filled = fillPlaceholders(skill.prompt, skill.schedule.defaults);
  const launched = await deck.launchScheduled(res.workspace, skill, filled);
  return launched ? "launched" : "skipped-overlap";
}
```

- [ ] **Step 3: Keep the backend path logging**

In `boot()`, replace the listener line

```ts
  await onScheduledFire((skillId) => { void handleScheduledFire(skillId); });
```

with one that logs a non-launch (the console warning that used to live inside
the function):

```ts
  await onScheduledFire((skillId) => {
    void handleScheduledFire(skillId).then((outcome) => {
      if (outcome !== "launched") console.warn("scheduled fire not launched:", skillId, outcome);
    });
  });
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. (No new unit test here — `main.ts` has no test harness; the
resolution rules are covered by Task 1 and the button behavior by Task 3.)

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "refactor(#9): handleScheduledFire reports an outcome instead of logging"
```

---

### Task 3: ⏰ button in the scenario row

**Files:**
- Modify: `src/skills.ts` (constructor callback; replace the `.sk-sched` span with a `.sk-now` button)
- Modify: `src/main.ts` (pass the 4th callback with modal feedback)
- Modify: `src/styles.css` (add `.sk-now`, drop `.sk-sched`)
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: `describeSchedule`, `nextRunLabel` (already imported in `skills.ts`), `handleScheduledFire`/`FireOutcome` (Task 2), `alertModal` (existing `src/modal.ts`).
- Produces: `SkillsPanel` 4th constructor parameter `onRunScheduled: (skill: Skill) => void`; row button `.sk-now`.

- [ ] **Step 1: Write the failing tests**

In `tests/skills.test.ts`, replace the existing test named
`"marks a scheduled scenario with ⏰ and describes it in the tooltip"` with the
two tests below (the `.sk-sched` span it asserted on is being removed).
`SkillsPanel`'s constructor gains a 4th argument, so the two other existing
tests in this file need a 4th argument too — pass `() => {}` there.

```ts
it("gives a scheduled scenario a ⏰ run-now button with the rule in its tooltip", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId: null,
      schedule: { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true } },
    { id: "s2", name: "Ручной", icon: "▶", prompt: "go", workspaceId: null },
  ]);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, () => {}, () => {});
  await panel.load();
  const buttons = mount.querySelectorAll<HTMLButtonElement>(".sk-now");
  expect(buttons).toHaveLength(1); // only the scheduled one
  expect(buttons[0].title).toContain("прогнать сейчас");
  expect(buttons[0].title).toContain("ежедневно 09:00");
  expect(buttons[0].title).toContain("след.:");
  expect(mount.querySelectorAll(".sk-sched")).toHaveLength(0); // indicator replaced by the button
});

it("clicking ⏰ runs the scenario without triggering the normal launch", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId: null,
      schedule: { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true } },
  ]);
  const onLaunch = vi.fn();
  const onRunScheduled = vi.fn();
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, onLaunch, onRunScheduled);
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".sk-now")!.click();
  expect(onRunScheduled).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  expect(onLaunch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skills.test.ts`
Expected: FAIL — no `.sk-now` element exists (and `.sk-sched` is still rendered).

- [ ] **Step 3: Add the callback and the button in `src/skills.ts`**

Add the 4th constructor parameter:

```ts
  constructor(
    private mount: HTMLElement,
    private getActiveWorkspaceId: () => string | null,
    private onLaunch: (skill: Skill) => void,
    private onRunScheduled: (skill: Skill) => void,
  ) {}
```

In `render()`, delete this existing block (the indicator inside the run button):

```ts
      if (s.schedule?.enabled) {
        const clock = document.createElement("span");
        clock.className = "sk-sched";
        clock.textContent = "⏰";
        clock.title = `${describeSchedule(s.schedule)} · след.: ${nextRunLabel(s.schedule.preset, new Date())}`;
        run.append(clock);
      }
```

Then, after the `edit` button is created and before `const x = document.createElement("button");`,
build the run-now button, and include it in the row append so the order is
`[▶ имя] [⏰] [✎] [✕]`:

```ts
      const now = s.schedule?.enabled ? document.createElement("button") : null;
      if (now && s.schedule) {
        now.className = "sk-now"; now.textContent = "⏰";
        // Doubles as the schedule indicator: the rule and next run live here.
        now.title = `прогнать сейчас · ${describeSchedule(s.schedule)} · след.: ${nextRunLabel(s.schedule.preset, new Date())}`;
        now.onclick = () => this.onRunScheduled(s);
      }
```

and replace `row.append(run, edit, x);` with:

```ts
      row.append(run, ...(now ? [now] : []), edit, x);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skills.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the callback in `src/main.ts`**

The `SkillsPanel` construction currently ends with the `onLaunch` arrow
function and `});`. Add the 4th argument after it:

```ts
const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null, async (skill) => {
  const ws = workspaces.active;
  if (!ws) return;
  const prompt = await resolvePrompt(skill.prompt, placeholderForm);
  if (prompt === null) return;
  deck.launch(ws, { ...skill, prompt });
}, (skill) => { void runScheduledNow(skill); });
```

Add this function right below `handleScheduledFire`:

```ts
/** ⏰ button: run a scheduled scenario now, exactly as the schedule would. The
 *  schedule itself is untouched — `lastRun` is written only by the backend
 *  loop, so the regular occurrence still fires. Unlike a backend-driven fire,
 *  a click must say why nothing happened. */
async function runScheduledNow(skill: Skill) {
  const outcome = await handleScheduledFire(skill.id);
  if (outcome === "skipped-overlap") {
    await alertModal("Прогон пропущен: предыдущий ещё активен.");
  } else if (outcome === "no-workspace") {
    await alertModal("У сценария нет доступного пространства: привяжите его или выберите пространство.");
  }
}
```

`Skill` is not yet imported as a type in `main.ts` — add it:

```ts
import type { Skill } from "./ipc";
```

- [ ] **Step 6: Swap the styles in `src/styles.css`**

Delete the `.sk-sched` rule (near the end of the file):

```css
.sk-sched { margin-left: 6px; opacity: 0.8; font-size: var(--fs-xs); }
```

and add a rule alongside the other row buttons. Unlike `.sk-edit`/`.sk-del`
(which appear on row hover), this one is always visible — it is also the
schedule indicator:

```css
.sk-now { background: none; border: none; color: var(--fg-subtle); border-radius: var(--r-sm); cursor: pointer; padding: 0 4px; font-size: var(--fs-xs); transition: color var(--dur-1) var(--ease); }
.sk-now:hover { color: var(--accent); }
```

- [ ] **Step 7: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS — 131 vitest tests (126 at plan start, +4 from Task 1, and in this task one replaced test becomes two: +1).

- [ ] **Step 8: Commit**

```bash
git add src/skills.ts src/main.ts src/styles.css tests/skills.test.ts
git commit -m "feat(#9): ⏰ button to run a scheduled scenario now"
```

---

## Manual smoke test (human, desktop GUI)

Run `npm run tauri dev` and verify:

1. A scenario with an enabled schedule shows ⏰ in its row; hovering shows «прогнать сейчас · ежедневно HH:MM · след.: …». A scenario without a schedule shows no ⏰.
2. Clicking ⏰ opens a `⏰ icon name` tile in the scenario's workspace and runs the prompt with placeholder defaults filled in — no placeholder dialog.
3. While that tile is `работает`/`ждёт ввода`, clicking ⏰ again shows «Прогон пропущен: предыдущий ещё активен.» and does not stack a second run.
4. Set the schedule a couple of minutes out, click ⏰ now, then wait: the scheduled run still fires at its time (the manual run did not consume it).
5. Regression: clicking the scenario name still asks for placeholders and launches in the active workspace; ✎ and ✕ still work.

---

## Self-Review

**Spec coverage:**
- Pure `resolveScheduledWorkspace` with the four rules → Task 1. ✅
- `FireOutcome` + backend path logging unchanged → Task 2. ✅
- 4th `SkillsPanel` callback, `.sk-now` button, indicator removed, row order, tooltip → Task 3. ✅
- `alertModal` on overlap / no workspace; silence on `not-scheduled` (unreachable from the UI) → Task 3 Step 5. ✅
- Styles: `.sk-now` added, `.sk-sched` removed → Task 3 Step 6. ✅
- Tests: resolution rules (Task 1), button presence/callback/tooltip/no `.sk-sched` (Task 3). ✅
- No Rust changes, no new dependencies → nothing in any task touches `src-tauri/` or `package.json`. ✅ This is what guarantees the spec's "manual run does not affect the schedule".

**Placeholder scan:** No TBD/TODO; every code step shows the full code, including the exact block to delete in Task 3.

**Type consistency:** `resolveScheduledWorkspace`/`WorkspaceResolution` (Task 1) are consumed with the same names and shape in Task 2; `FireOutcome` values returned in Task 2 are exactly the ones matched in Task 3 (`skipped-overlap`, `no-workspace`); `onRunScheduled` is named identically in `skills.ts`, its tests, and the `main.ts` call site.
