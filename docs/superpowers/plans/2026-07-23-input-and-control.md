# Input & Control (Group A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести ввод и управление cowork-deck: нативный выбор папки + формы создания/редактирования, клавиатурные хоткеи + лёгкая палитра, поиск/очистка терминала, клик уведомления → фокус нужной сессии.

**Architecture:** Правки поверх ветки `feat/release-1.0`. Новая логика выносится в маленькие модули (`dialog.ts`, `forms.ts`, `commands.ts`, `palette.ts`, `notify.ts`) с чистыми функциями под юнит-тесты и тонкими обёртками над Tauri-плагинами (мокаются в jsdom). Нативные диалоги / клик уведомления / фокус окна проверяются вручную на десктопе.

**Tech Stack:** Tauri v2, Rust, ванильный TypeScript, xterm.js (+ `@xterm/addon-search`), `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-notification`, Vite, Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-07-23-input-and-control-design.md`

## Global Constraints

- Только ванильный TypeScript, без фреймворков. Целевой расход памяти < 100 МБ; только лёгкие зависимости.
- Тёмная тема, палитра One Dark, дизайн-токены из `src/styles.css` (`:root`). Анимации только transform/opacity/box-shadow; `prefers-reduced-motion` уже глобально обработан — не дублировать.
- UI-строки на русском, стиль существующий («готов/работает/ждёт ввода/завершён/ошибка»).
- Команды тестов неизменны: `npm test` (vitest), `cargo test --manifest-path src-tauri/Cargo.toml`. Не ломать существующие тесты (`ipc`, `sessions`, `sessions-util`, `modal`; Rust inline + `tests/reporter.rs`).
- Хоткеи-комбо приложения (Cmd/Ctrl+…) НЕ должны воровать обычный ввод у xterm — перехват через `term.attachCustomKeyEventHandler`.
- Conventional Commits.

---

## File Structure

**Новые файлы (frontend):**
- `src/dialog.ts` — обёртка `pickFolder()` над `@tauri-apps/plugin-dialog`.
- `src/forms.ts` — `workspaceForm()`, `skillForm()` (модалки-формы поверх оверлея из `modal.ts`).
- `src/commands.ts` — реестр команд + чистые `matchHotkey()`, `nextWaitingIndex()`.
- `src/palette.ts` — модалка командной палитры.
- `src/notify.ts` — маппинг уведомлений и обёртка `onAction` + фокус окна.

**Изменяемые:**
- `src/modal.ts` — экспорт помощников для форм (overlay/actions), если понадобится переиспользовать.
- `src/workspaces.ts`, `src/skills.ts` — переход на формы + редактирование (✎).
- `src/terminal.ts` — `attachCustomKeyEventHandler`, SearchAddon, `search/findNext/findPrevious/clear`.
- `src/sessions.ts` — публичные методы для команд (`focusByIndex`, `focusNextWaiting`, `closeActive`, `activeSession`), интеграция поиска/очистки и notify-id.
- `src/main.ts` — регистрация глобального обработчика клавиш + палитры + notify.
- `src/styles.css` — стили форм, палитры, бара поиска.
- `src-tauri/src/main.rs` — регистрация `tauri_plugin_dialog`.
- `src-tauri/Cargo.toml`, `package.json` — зависимости.
- `src-tauri/capabilities/default.json` — разрешения `dialog:*`, `core:window:*`.

**Tests:** `tests/dialog.test.ts`, `tests/forms.test.ts`, `tests/commands.test.ts`, `tests/palette.test.ts`, `tests/notify.test.ts` (все jsdom, кроме чисто-функциональных частей `commands`).

---

## Task 1: Плагин dialog + обёртка pickFolder

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src-tauri/capabilities/default.json`
- Create: `src/dialog.ts`, `tests/dialog.test.ts`

**Interfaces:**
- Produces: `pickFolder(): Promise<string | null>` — открывает нативный выбор папки, возвращает путь или `null` при отмене.

- [ ] **Step 1: Установить зависимости**

Run:
```bash
npm i @tauri-apps/plugin-dialog
cargo add tauri-plugin-dialog --manifest-path src-tauri/Cargo.toml
```
Expected: `@tauri-apps/plugin-dialog` в dependencies; `tauri-plugin-dialog` в Cargo.toml.

- [ ] **Step 2: Зарегистрировать плагин в Rust**

В `src-tauri/src/main.rs`, в цепочке `tauri::Builder::default()` рядом с `.plugin(tauri_plugin_notification::init())` добавить:
```rust
        .plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 3: Разрешения capability**

В `src-tauri/capabilities/default.json` в массив `permissions` добавить `"dialog:default"`:
```json
    "core:default",
    "notification:default",
    "dialog:default"
```

- [ ] **Step 4: Написать падающий тест обёртки**

Create `tests/dialog.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

import { pickFolder } from "../src/dialog";

describe("pickFolder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the selected directory path", async () => {
    openMock.mockResolvedValueOnce("/Users/me/proj");
    expect(await pickFolder()).toBe("/Users/me/proj");
    expect(openMock).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it("returns null when cancelled", async () => {
    openMock.mockResolvedValueOnce(null);
    expect(await pickFolder()).toBeNull();
  });
});
```

- [ ] **Step 5: Запустить тест — RED**

Run: `npm test -- dialog`
Expected: FAIL — cannot resolve `../src/dialog`.

- [ ] **Step 6: Реализовать `src/dialog.ts`**

```ts
import { open } from "@tauri-apps/plugin-dialog";

/** Native folder picker. Returns the chosen absolute path, or null if the
 *  user cancelled. */
export async function pickFolder(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}
```

- [ ] **Step 7: Запустить тест — GREEN + typecheck**

Run: `npm test -- dialog && npx tsc --noEmit`
Expected: PASS, без ошибок типов.

- [ ] **Step 8: Проверить сборку Rust**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: успешная сборка (плагин компилируется). Если не собирается — сообщить как BLOCKED.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/main.rs src-tauri/capabilities/default.json src/dialog.ts tests/dialog.test.ts
git commit -m "feat: add dialog plugin and pickFolder() native folder picker wrapper"
```

---

## Task 2: Формы создания/редактирования (forms.ts)

**Files:**
- Create: `src/forms.ts`, `tests/forms.test.ts`
- Modify: `src/styles.css` (стили полей формы)

**Interfaces:**
- Consumes: `pickFolder` (Task 1).
- Produces:
  - `workspaceForm(initial?: { name: string; path: string; color: string }): Promise<{ name: string; path: string; color: string } | null>`
  - `skillForm(activeWorkspaceId: string | null, initial?: { name: string; icon: string; prompt: string; workspaceId: string | null }): Promise<{ name: string; icon: string; prompt: string; workspaceId: string | null } | null>`

- [ ] **Step 1: Написать падающие тесты (jsdom)**

Create `tests/forms.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pickFolderMock } = vi.hoisted(() => ({ pickFolderMock: vi.fn() }));
vi.mock("../src/dialog", () => ({ pickFolder: pickFolderMock }));

import { workspaceForm, skillForm } from "../src/forms";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("workspaceForm", () => {
  it("collects name/path/color and resolves on OK", async () => {
    const p = workspaceForm();
    (document.querySelector(".form-name") as HTMLInputElement).value = "proj";
    (document.querySelector(".form-path") as HTMLInputElement).value = "/p";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res).toMatchObject({ name: "proj", path: "/p" });
    expect(typeof res!.color).toBe("string");
  });

  it("fills the path via pickFolder button", async () => {
    pickFolderMock.mockResolvedValueOnce("/picked");
    const p = workspaceForm();
    document.querySelector<HTMLButtonElement>(".form-pick")!.click();
    await Promise.resolve();
    expect((document.querySelector(".form-path") as HTMLInputElement).value).toBe("/picked");
    (document.querySelector(".form-name") as HTMLInputElement).value = "n";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)!.path).toBe("/picked");
  });

  it("prefills initial values when editing", () => {
    workspaceForm({ name: "old", path: "/old", color: "#61afef" });
    expect((document.querySelector(".form-name") as HTMLInputElement).value).toBe("old");
    expect((document.querySelector(".form-path") as HTMLInputElement).value).toBe("/old");
  });

  it("resolves null on cancel", async () => {
    const p = workspaceForm();
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
  });
});

describe("skillForm", () => {
  it("collects fields incl. multiline prompt and scope", async () => {
    const p = skillForm("ws-1");
    (document.querySelector(".form-name") as HTMLInputElement).value = "Fix";
    (document.querySelector(".form-prompt") as HTMLTextAreaElement).value = "line1\nline2";
    (document.querySelector(".form-scope") as HTMLInputElement).checked = true; // bind to workspace
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res).toMatchObject({ name: "Fix", prompt: "line1\nline2", workspaceId: "ws-1" });
    expect(res!.icon).toBe("▶"); // default when empty
  });
});
```

- [ ] **Step 2: Запустить тест — RED**

Run: `npm test -- forms`
Expected: FAIL — cannot resolve `../src/forms`.

- [ ] **Step 3: Реализовать `src/forms.ts`**

```ts
import { pickFolder } from "./dialog";

const COLORS = ["#61afef", "#98c379", "#e5c07b", "#c678dd", "#e06c75", "#56b6c2"];

function overlay(): { overlay: HTMLElement; box: HTMLElement } {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  overlay.append(box);
  document.body.append(overlay);
  return { overlay, box };
}

function labeled(labelText: string, field: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "form-row";
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = labelText;
  wrap.append(span, field);
  return wrap;
}

function actions(): { row: HTMLElement; ok: HTMLButtonElement; cancel: HTMLButtonElement } {
  const row = document.createElement("div");
  row.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "modal-cancel"; cancel.textContent = "Отмена";
  const ok = document.createElement("button");
  ok.className = "modal-ok"; ok.textContent = "OK";
  row.append(cancel, ok);
  return { row, ok, cancel };
}

export function workspaceForm(
  initial?: { name: string; path: string; color: string },
): Promise<{ name: string; path: string; color: string } | null> {
  return new Promise((resolve) => {
    const { overlay: ov, box } = overlay();
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = initial ? "Изменить пространство" : "Новое пространство";

    const name = document.createElement("input");
    name.className = "modal-input form-name"; name.type = "text";
    name.value = initial?.name ?? "";

    const path = document.createElement("input");
    path.className = "modal-input form-path"; path.type = "text";
    path.value = initial?.path ?? ""; path.placeholder = "путь к папке проекта";
    const pick = document.createElement("button");
    pick.className = "form-pick"; pick.type = "button"; pick.textContent = "Выбрать папку…";
    pick.onclick = async () => {
      const p = await pickFolder();
      if (p) {
        path.value = p;
        if (!name.value.trim()) name.value = p.split("/").filter(Boolean).pop() ?? "";
      }
    };
    const pathRow = document.createElement("div");
    pathRow.className = "form-pathrow";
    pathRow.append(path, pick);

    let color = initial?.color ?? COLORS[0];
    const swatches = document.createElement("div");
    swatches.className = "form-swatches";
    for (const c of COLORS) {
      const dot = document.createElement("button");
      dot.type = "button"; dot.className = "form-swatch"; dot.style.background = c;
      dot.classList.toggle("selected", c === color);
      dot.onclick = () => {
        color = c;
        swatches.querySelectorAll(".form-swatch").forEach((s) => s.classList.remove("selected"));
        dot.classList.add("selected");
      };
      swatches.append(dot);
    }

    const { row, ok, cancel } = actions();
    box.append(title, labeled("Имя", name), labeled("Папка", pathRow), labeled("Цвет", swatches), row);

    const close = (v: { name: string; path: string; color: string } | null) => { ov.remove(); resolve(v); };
    ok.onclick = () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n || !p) return; // требуются оба
      close({ name: n, path: p, color });
    };
    cancel.onclick = () => close(null);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
    name.focus();
  });
}

export function skillForm(
  activeWorkspaceId: string | null,
  initial?: { name: string; icon: string; prompt: string; workspaceId: string | null },
): Promise<{ name: string; icon: string; prompt: string; workspaceId: string | null } | null> {
  return new Promise((resolve) => {
    const { overlay: ov, box } = overlay();
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = initial ? "Изменить сценарий" : "Новый сценарий";

    const name = document.createElement("input");
    name.className = "modal-input form-name"; name.type = "text";
    name.value = initial?.name ?? "";

    const icon = document.createElement("input");
    icon.className = "modal-input form-icon"; icon.type = "text";
    icon.value = initial?.icon ?? ""; icon.placeholder = "▶";

    const promptField = document.createElement("textarea");
    promptField.className = "modal-input form-prompt"; promptField.rows = 4;
    promptField.value = initial?.prompt ?? "";

    const scope = document.createElement("input");
    scope.className = "form-scope"; scope.type = "checkbox";
    scope.checked = initial ? initial.workspaceId != null : false;

    const { row, ok, cancel } = actions();
    box.append(
      title, labeled("Имя", name), labeled("Значок", icon),
      labeled("Задание", promptField), labeled("Только для текущего пространства", scope), row,
    );

    const close = (v: { name: string; icon: string; prompt: string; workspaceId: string | null } | null) => { ov.remove(); resolve(v); };
    ok.onclick = () => {
      const n = name.value.trim(); const pr = promptField.value.trim();
      if (!n || !pr) return;
      close({
        name: n, icon: icon.value.trim() || "▶", prompt: pr,
        workspaceId: scope.checked ? activeWorkspaceId : null,
      });
    };
    cancel.onclick = () => close(null);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
    name.focus();
  });
}
```

- [ ] **Step 4: Запустить тесты — GREEN**

Run: `npm test -- forms && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Стили форм в styles.css**

Добавить в конец `src/styles.css`:
```css
.form-row { display: flex; flex-direction: column; gap: 4px; }
.form-row > .form-label { color: var(--fg-muted); font-family: var(--font-ui); font-size: var(--fs-xs); }
.form-row label.form-row { flex-direction: row; align-items: center; gap: var(--sp-2); }
.form-pathrow { display: flex; gap: var(--sp-2); }
.form-pathrow .form-path { flex: 1; }
.form-pick { padding: 6px 10px; border-radius: var(--r-sm); border: 1px dashed var(--border); background: none; color: var(--fg-muted); font: inherit; font-size: var(--fs-sm); cursor: pointer; white-space: nowrap; }
.form-pick:hover { border-color: var(--accent); color: var(--accent); border-style: solid; }
.form-prompt { resize: vertical; min-height: 72px; font-family: var(--font-mono); }
.form-swatches { display: flex; gap: 6px; }
.form-swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.form-swatch.selected { border-color: var(--fg); box-shadow: 0 0 0 2px var(--bg-panel); }
```

- [ ] **Step 6: Регрессия + commit**

Run: `npm test`
Expected: все наборы зелёные.
```bash
git add src/forms.ts tests/forms.test.ts src/styles.css
git commit -m "feat: workspace and skill create/edit form modals"
```

---

## Task 3: Переключить workspaces на формы + редактирование

**Files:**
- Modify: `src/workspaces.ts`
- Test: `tests/forms.test.ts` уже покрывает формы; для панели — точечный jsdom-тест (ниже).

**Interfaces:**
- Consumes: `workspaceForm` (Task 2).
- Produces: `WorkspacesPanel` с `add()` и `edit(id)` через форму; ✎ на строке.

- [ ] **Step 1: Заменить `add()` и добавить `edit()`**

В `src/workspaces.ts`: заменить импорт
```ts
import { promptModal, confirmModal } from "./modal";
```
на
```ts
import { confirmModal } from "./modal";
import { workspaceForm } from "./forms";
```
Заменить метод `add()` (строки 26-34) на:
```ts
  private async add() {
    const res = await workspaceForm();
    if (!res) return;
    const ws: Workspace = { id: crypto.randomUUID(), ...res };
    this.items = await saveWorkspace(ws);
    this.select(ws.id);
  }

  private async edit(id: string) {
    const cur = this.items.find((w) => w.id === id);
    if (!cur) return;
    const res = await workspaceForm({ name: cur.name, path: cur.path, color: cur.color });
    if (!res) return;
    this.items = await saveWorkspace({ ...cur, ...res });
    this.render();
  }
```

- [ ] **Step 2: Добавить кнопку ✎ в `render()`**

В `render()`, после создания `label` и перед `x` (кнопка удаления), добавить:
```ts
      const edit = document.createElement("button");
      edit.className = "ws-edit"; edit.textContent = "✎"; edit.title = "изменить";
      edit.onclick = () => this.edit(w.id);
```
и изменить `row.append(dot, label, x);` на `row.append(dot, label, edit, x);`

- [ ] **Step 3: Стиль ✎ (как у ✕, скрыт до hover)**

В `src/styles.css` в правило `.sk-del, .ws-del { ... }` добавить селекторы `.ws-edit, .sk-edit` (те же свойства). Простейше — добавить отдельное правило рядом:
```css
.ws-edit, .sk-edit { background: none; border: none; color: var(--fg-subtle); border-radius: var(--r-sm); cursor: pointer; padding: 0 4px; opacity: 0; transition: opacity var(--dur-1) var(--ease), color var(--dur-1) var(--ease); }
.ws-row:hover .ws-edit, .sk-row:hover .sk-edit { opacity: 1; }
.ws-edit:hover, .sk-edit:hover { color: var(--accent); }
```

- [ ] **Step 4: jsdom-тест панели (создание через форму)**

Create `tests/workspaces.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveWorkspace, workspaceForm } = vi.hoisted(() => ({ saveWorkspace: vi.fn(), workspaceForm: vi.fn() }));
vi.mock("../src/ipc", () => ({
  listWorkspaces: vi.fn().mockResolvedValue([]),
  saveWorkspace,
  removeWorkspace: vi.fn(),
}));
vi.mock("../src/forms", () => ({ workspaceForm }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));

import { WorkspacesPanel } from "../src/workspaces";

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

it("creates a workspace from the form result", async () => {
  workspaceForm.mockResolvedValueOnce({ name: "P", path: "/p", color: "#61afef" });
  saveWorkspace.mockResolvedValueOnce([{ id: "x", name: "P", path: "/p", color: "#61afef" }]);
  const mount = document.createElement("div");
  const panel = new WorkspacesPanel(mount, () => {});
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".ws-add")!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: "P", path: "/p" }));
});
```

- [ ] **Step 5: Прогон + commit**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.
```bash
git add src/workspaces.ts src/styles.css tests/workspaces.test.ts
git commit -m "feat: workspace create/edit via form modal with folder picker"
```

---

## Task 4: Переключить skills на формы + редактирование

**Files:**
- Modify: `src/skills.ts`
- Create: `tests/skills.test.ts`

**Interfaces:**
- Consumes: `skillForm` (Task 2).
- Produces: `SkillsPanel` с `add()`/`edit(id)` через форму; ✎ на строке.

- [ ] **Step 1: Заменить `add()` и добавить `edit()`**

В `src/skills.ts` заменить импорт `import { promptModal, confirmModal } from "./modal";` на:
```ts
import { confirmModal } from "./modal";
import { skillForm } from "./forms";
```
Заменить `add()` на:
```ts
  private async add() {
    const res = await skillForm(this.getActiveWorkspaceId());
    if (!res) return;
    const sk: Skill = { id: crypto.randomUUID(), ...res };
    this.items = await saveSkill(sk);
    this.render();
  }

  private async edit(id: string) {
    const cur = this.items.find((s) => s.id === id);
    if (!cur) return;
    const res = await skillForm(this.getActiveWorkspaceId(), {
      name: cur.name, icon: cur.icon, prompt: cur.prompt, workspaceId: cur.workspaceId ?? null,
    });
    if (!res) return;
    this.items = await saveSkill({ ...cur, ...res });
    this.render();
  }
```

- [ ] **Step 2: Кнопка ✎ в `render()`**

В `render()` после создания `run` и перед `x` добавить:
```ts
      const edit = document.createElement("button");
      edit.className = "sk-edit"; edit.textContent = "✎"; edit.title = "изменить";
      edit.onclick = () => this.edit(s.id);
```
и заменить `row.append(run, x);` на `row.append(run, edit, x);`

- [ ] **Step 3: jsdom-тест**

Create `tests/skills.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveSkill, skillForm } = vi.hoisted(() => ({ saveSkill: vi.fn(), skillForm: vi.fn() }));
vi.mock("../src/ipc", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
  saveSkill,
  removeSkill: vi.fn(),
}));
vi.mock("../src/forms", () => ({ skillForm }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));

import { SkillsPanel } from "../src/skills";

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

it("creates a skill from the form result", async () => {
  skillForm.mockResolvedValueOnce({ name: "Fix", icon: "▶", prompt: "do", workspaceId: null });
  saveSkill.mockResolvedValueOnce([{ id: "s", name: "Fix", icon: "▶", prompt: "do", workspaceId: null }]);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, () => {});
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".sk-add")!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "Fix", prompt: "do" }));
});
```

- [ ] **Step 4: Прогон + commit**

Run: `npm test && npx tsc --noEmit`
```bash
git add src/skills.ts tests/skills.test.ts
git commit -m "feat: skill create/edit via form modal with multiline prompt"
```

---

## Task 5: Реестр команд + чистые функции (commands.ts) + публичные методы Deck

**Files:**
- Create: `src/commands.ts`, `tests/commands.test.ts`
- Modify: `src/sessions.ts` (публичные методы для команд)

**Interfaces:**
- Produces:
  - `matchHotkey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): string | null` — id команды или null.
  - `nextWaitingIndex(states: SessionState[], current: number): number | null` — индекс следующей ждущей по кругу.
  - `Deck.focusByIndex(n: number): void`, `Deck.focusNextWaiting(): void`, `Deck.closeActive(): void`, геттер `Deck.activeSession: string | null`, `Deck.searchActive(): void`, `Deck.clearActive(): void`.
  - `buildCommands(deck, workspaces, skills): Command[]` где `Command = { id; title; run: () => void; hotkey?: string }`.

- [ ] **Step 1: Падающие юнит-тесты чистых функций**

Create `tests/commands.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { matchHotkey, nextWaitingIndex } from "../src/commands";
import type { SessionState } from "../src/ipc";

describe("matchHotkey", () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false };
  it("maps Cmd+K to palette", () => {
    expect(matchHotkey({ ...base, key: "k", metaKey: true })).toBe("palette");
  });
  it("maps Ctrl+K to palette", () => {
    expect(matchHotkey({ ...base, key: "k", ctrlKey: true })).toBe("palette");
  });
  it("maps Cmd+digit to focus-N", () => {
    expect(matchHotkey({ ...base, key: "3", metaKey: true })).toBe("focus-3");
  });
  it("maps Cmd+Shift+] to next-waiting", () => {
    expect(matchHotkey({ ...base, key: "]", metaKey: true, shiftKey: true })).toBe("next-waiting");
  });
  it("returns null without modifier", () => {
    expect(matchHotkey({ ...base, key: "k" })).toBeNull();
  });
});

describe("nextWaitingIndex", () => {
  const S = (x: string[]): SessionState[] => x as SessionState[];
  it("finds the next waiting after current, wrapping", () => {
    const states = S(["idle", "waitingInput", "working", "waitingInput"]);
    expect(nextWaitingIndex(states, 1)).toBe(3);
    expect(nextWaitingIndex(states, 3)).toBe(1); // wrap
  });
  it("returns null when none waiting", () => {
    expect(nextWaitingIndex(S(["idle", "working"]), 0)).toBeNull();
  });
  it("works when current is -1 (none focused)", () => {
    expect(nextWaitingIndex(S(["working", "waitingInput"]), -1)).toBe(1);
  });
});
```

- [ ] **Step 2: RED**

Run: `npm test -- commands`
Expected: FAIL — cannot resolve `../src/commands`.

- [ ] **Step 3: Реализовать чистые функции + типы в `src/commands.ts`**

```ts
import type { SessionState } from "./ipc";

export interface Command { id: string; title: string; run: () => void; hotkey?: string }

export function matchHotkey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): string | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const k = e.key.toLowerCase();
  if (k === "k") return "palette";
  if (k === "n" && !e.shiftKey) return "new-session";
  if (k === "w" && !e.shiftKey) return "close-active";
  if (k === "f" && !e.shiftKey) return "search";
  if (k === "]" && e.shiftKey) return "next-waiting";
  if (/^[1-9]$/.test(k) && !e.shiftKey) return `focus-${k}`;
  return null;
}

export function nextWaitingIndex(states: SessionState[], current: number): number | null {
  const n = states.length;
  for (let i = 1; i <= n; i++) {
    const idx = ((current + i) % n + n) % n;
    if (states[idx] === "waitingInput") return idx;
  }
  return null;
}
```

- [ ] **Step 4: GREEN**

Run: `npm test -- commands`
Expected: PASS.

- [ ] **Step 5: Публичные методы Deck**

В `src/sessions.ts` добавить в класс `Deck` (например после `focusTile`). Использовать порядок вставки Map (совпадает с порядком плиток в деке):
```ts
  get activeSession(): string | null {
    for (const [id, t] of this.tiles) if (t.el.classList.contains("is-active")) return id;
    return null;
  }
  focusByIndex(n: number) {
    const ids = [...this.tiles.keys()];
    const id = ids[n - 1];
    if (id) this.focusTile(id);
  }
  focusNextWaiting() {
    const ids = [...this.tiles.keys()];
    const states = ids.map((id) => this.tiles.get(id)!.state);
    const cur = ids.indexOf(this.activeSession ?? "");
    const idx = nextWaitingIndex(states, cur);
    if (idx != null) this.focusTile(ids[idx]);
  }
  closeActive() {
    const id = this.activeSession;
    if (id) this.remove(id);
  }
  searchActive() {
    const id = this.activeSession;
    if (id) this.tiles.get(id)!.panel.openSearch();
  }
  clearActive() {
    const id = this.activeSession;
    if (id) this.tiles.get(id)!.panel.clear();
  }
```
Добавить импорт в начало `sessions.ts`: `import { nextWaitingIndex } from "./commands";` (совместно с существующими). `focusTile` и `remove` — сделать методы, вызываемые командами, доступными: они `private`, но команды строятся через методы самого Deck, поэтому оставить private и вызывать изнутри публичных обёрток (как выше). `panel.openSearch()`/`panel.clear()` появятся в Task 8 — если Task 8 ещё не сделан, добавить временные заглушки в `TerminalPanel` (`openSearch(){} clear(){}`), которые Task 8 реализует. (В subagent-порядке Task 8 идёт позже — заглушки допустимы и помечаются комментарием `// реализуется в Task 8`.)

- [ ] **Step 6: Прогон + commit**

Run: `npm test && npx tsc --noEmit`
```bash
git add src/commands.ts tests/commands.test.ts src/sessions.ts src/terminal.ts
git commit -m "feat: command registry, hotkey matcher, next-waiting nav and Deck command methods"
```

---

## Task 6: Глобальные хоткеи + перехват в xterm

**Files:**
- Modify: `src/main.ts` (глобальный keydown → команда), `src/terminal.ts` (`attachCustomKeyEventHandler`)

**Interfaces:**
- Consumes: `matchHotkey`, `buildCommands`, `Deck` методы, панели.
- Produces: рабочие хоткеи, не крадущие обычный ввод у терминала.

- [ ] **Step 1: Перехват в xterm**

В `src/terminal.ts` в конструкторе после `this.term.open(mount);` добавить:
```ts
    // Перехватываем ТОЛЬКО распознанные хоткеи приложения; всё остальное
    // (в т.ч. Ctrl+C/D/L, обычный ввод) отдаём терминалу.
    import { matchHotkey } from "./commands"; // (импорт — вверху файла)
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && matchHotkey(e)) return false;
      return true;
    });
```

- [ ] **Step 2: Собрать команды и повесить глобальный обработчик в main.ts**

В `src/main.ts` после создания `deck`, `workspaces`, `skills` добавить:
```ts
import { matchHotkey } from "./commands";

const COMMANDS: Record<string, () => void> = {
  "palette": () => openPalette(),         // openPalette из Task 7; до Task 7 — временно no-op
  "new-session": () => { const ws = workspaces.active; if (ws) deck.launch(ws, null); },
  "close-active": () => deck.closeActive(),
  "search": () => deck.searchActive(),
  "next-waiting": () => deck.focusNextWaiting(),
};

window.addEventListener("keydown", (e) => {
  const id = matchHotkey(e);
  if (!id) return;
  if (id.startsWith("focus-")) {
    e.preventDefault();
    deck.focusByIndex(Number(id.slice("focus-".length)));
    return;
  }
  const run = COMMANDS[id];
  if (run) { e.preventDefault(); run(); }
});
```
Примечание: `openPalette` реализуется в Task 7; до тех пор оставить `"palette": () => {}` с комментарием `// Task 7`.

- [ ] **Step 3: Проверка типов + регрессия**

Run: `npx tsc --noEmit && npm test`
Expected: без ошибок; существующие тесты зелёные (изменения в main.ts/terminal.ts не покрываются юнит-тестами — проверяются вручную на десктопе).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/terminal.ts
git commit -m "feat: global hotkey dispatch with xterm passthrough guard"
```

---

## Task 7: Командная палитра (palette.ts)

**Files:**
- Create: `src/palette.ts`, `tests/palette.test.ts`
- Modify: `src/main.ts` (подключить `openPalette`), `src/styles.css`

**Interfaces:**
- Consumes: `Command[]`.
- Produces: `openPalette(commands: Command[]): void` — модалка с фильтром и списком; Enter/клик выполняет `run`, Esc закрывает.
- Экспорт для теста: `filterCommands(commands: Command[], query: string): Command[]`.

- [ ] **Step 1: Падающие тесты**

Create `tests/palette.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openPalette, filterCommands } from "../src/palette";
import type { Command } from "../src/commands";

beforeEach(() => { document.body.innerHTML = ""; });

const cmds = (): Command[] => [
  { id: "a", title: "Новая сессия", run: vi.fn() },
  { id: "b", title: "Закрыть активную", run: vi.fn() },
];

describe("filterCommands", () => {
  it("filters by case-insensitive substring of title", () => {
    const r = filterCommands(cmds(), "закр");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("b");
  });
  it("returns all for empty query", () => {
    expect(filterCommands(cmds(), "")).toHaveLength(2);
  });
});

describe("openPalette", () => {
  it("runs the command on click and closes", () => {
    const list = cmds();
    openPalette(list);
    const first = document.querySelector<HTMLElement>(".palette-item")!;
    first.click();
    expect(list[0].run).toHaveBeenCalled();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });
});
```

- [ ] **Step 2: RED**

Run: `npm test -- palette`
Expected: FAIL — cannot resolve `../src/palette`.

- [ ] **Step 3: Реализовать `src/palette.ts`**

```ts
import type { Command } from "./commands";

export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.title.toLowerCase().includes(q));
}

export function openPalette(commands: Command[]): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box palette-box";
  overlay.append(box);
  document.body.append(overlay);

  const input = document.createElement("input");
  input.className = "modal-input palette-input"; input.type = "text";
  input.placeholder = "Команда…";
  const list = document.createElement("div");
  list.className = "palette-list";
  box.append(input, list);

  let items: Command[] = commands;
  let sel = 0;
  const close = () => overlay.remove();
  const run = (c: Command) => { close(); c.run(); };

  const render = () => {
    list.innerHTML = "";
    items = filterCommands(commands, input.value);
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    items.forEach((c, i) => {
      const el = document.createElement("div");
      el.className = "palette-item" + (i === sel ? " selected" : "");
      el.textContent = c.title;
      el.onmousedown = (e) => { e.preventDefault(); run(c); };
      list.append(el);
    });
  };

  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[sel]) run(items[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  render();
  input.focus();
}
```

- [ ] **Step 4: GREEN**

Run: `npm test -- palette`
Expected: PASS.

- [ ] **Step 5: Подключить в main.ts**

В `src/main.ts` собрать список команд и заменить временный `"palette"` no-op:
```ts
import { openPalette } from "./palette";
import type { Command } from "./commands";

function paletteCommands(): Command[] {
  return [
    { id: "new-session", title: "Новая сессия", run: () => { const ws = workspaces.active; if (ws) deck.launch(ws, null); } },
    { id: "close-active", title: "Закрыть активную сессию", run: () => deck.closeActive() },
    { id: "next-waiting", title: "К следующей ждущей вводу", run: () => deck.focusNextWaiting() },
    { id: "search", title: "Поиск в терминале", run: () => deck.searchActive() },
    { id: "clear", title: "Очистить терминал", run: () => deck.clearActive() },
  ];
}
```
и в объекте `COMMANDS` заменить `"palette"` на `() => openPalette(paletteCommands())`.

- [ ] **Step 6: Стили палитры в styles.css**

```css
.palette-box { min-width: 420px; gap: var(--sp-2); }
.palette-input { width: 100%; }
.palette-list { display: flex; flex-direction: column; max-height: 300px; overflow: auto; }
.palette-item { padding: 8px 10px; border-radius: var(--r-sm); color: var(--fg); font-size: var(--fs-base); cursor: pointer; }
.palette-item:hover, .palette-item.selected { background: var(--accent-weak); color: var(--accent); }
```

- [ ] **Step 7: Прогон + commit**

Run: `npm test && npx tsc --noEmit`
```bash
git add src/palette.ts tests/palette.test.ts src/main.ts src/styles.css
git commit -m "feat: command palette (Cmd+K) with filter and keyboard nav"
```

---

## Task 8: Поиск и очистка терминала

**Files:**
- Modify: `src/terminal.ts` (SearchAddon + методы + заменить заглушки из Task 5), `src/sessions.ts` (бар поиска в плитке + кнопка очистки в шапке), `src/styles.css`, `package.json`
- Create: `tests/terminal-search.test.ts`

**Interfaces:**
- Produces: `TerminalPanel.openSearch()`, `TerminalPanel.clear()`, `TerminalPanel.search(term)`, `TerminalPanel.findNext()`, `TerminalPanel.findPrevious()`.

- [ ] **Step 1: Зависимость**

Run: `npm i @xterm/addon-search`
Expected: в dependencies.

- [ ] **Step 2: Падающий тест обёрток (мок аддона)**

Create `tests/terminal-search.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const findNext = vi.fn(); const findPrevious = vi.fn();
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class { findNext = findNext; findPrevious = findPrevious; },
}));
// xterm сам по себе тяжёл для jsdom — мокаем минимально:
const clear = vi.fn();
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    onData() {} onResize() {}
    attachCustomKeyEventHandler() {}
    focus() {}
    clear = clear;
    write() {}
    dispose() {}
    cols = 80; rows = 24;
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

import { TerminalPanel } from "../src/terminal";

beforeEach(() => vi.clearAllMocks());

it("search delegates to the search addon", () => {
  const panel = new TerminalPanel("s", document.createElement("div"));
  panel.search("foo");
  expect(findNext).toHaveBeenCalledWith("foo");
  panel.findPrevious();
  expect(findPrevious).toHaveBeenCalled();
});

it("clear delegates to term.clear", () => {
  const panel = new TerminalPanel("s", document.createElement("div"));
  panel.clear();
  expect(clear).toHaveBeenCalled();
});
```

- [ ] **Step 3: RED**

Run: `npm test -- terminal-search`
Expected: FAIL (методы отсутствуют / заглушки no-op из Task 5).

- [ ] **Step 4: Реализовать в `src/terminal.ts`**

Добавить импорт: `import { SearchAddon } from "@xterm/addon-search";`
В конструкторе после `this.fitAddon`:
```ts
    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.searchAddon);
```
Добавить поле `private searchAddon: SearchAddon;` и методы (заменив заглушки из Task 5):
```ts
  search(term: string) { if (term) this.searchAddon.findNext(term); this.lastSearch = term; }
  findNext() { if (this.lastSearch) this.searchAddon.findNext(this.lastSearch); }
  findPrevious() { if (this.lastSearch) this.searchAddon.findPrevious(this.lastSearch); }
  clear() { this.term.clear(); }
```
и поле `private lastSearch = "";`. Метод `openSearch()` реализуется на уровне плитки (Deck) — оставить в `TerminalPanel` только `focusSearch` вызов не нужен; `openSearch` на плитке (Step 5).

- [ ] **Step 5: Бар поиска в плитке + кнопка очистки (sessions.ts)**

В `launch()` при создании `head` добавить кнопку очистки перед `close`:
```ts
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "⌫"; clearBtn.className = "tile-close"; clearBtn.title = "очистить";
    clearBtn.onclick = () => tile.panel.clear();
```
и включить её в `head.append(...)` (перед `close`). Добавить бар поиска в `mount`-контейнер плитки: элемент `.tile-search` (скрыт), с input + next/prev + закрыть; хранить ссылку в `Tile`. Реализовать `openSearch()` на уровне Deck-метода `searchActive()` (Task 5) — показать бар активной плитки и сфокусировать его input. Полный код бара:
```ts
    const searchBar = document.createElement("div");
    searchBar.className = "tile-search hidden";
    const sInput = document.createElement("input"); sInput.className = "tile-search-input"; sInput.placeholder = "поиск…";
    const sNext = document.createElement("button"); sNext.textContent = "▼"; sNext.className = "tile-search-btn";
    const sPrev = document.createElement("button"); sPrev.textContent = "▲"; sPrev.className = "tile-search-btn";
    const sClose = document.createElement("button"); sClose.textContent = "✕"; sClose.className = "tile-search-btn";
    searchBar.append(sInput, sPrev, sNext, sClose);
    sInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); tile.panel.search(sInput.value); }
      else if (e.key === "Escape") { e.preventDefault(); searchBar.classList.add("hidden"); tile.panel.focus(); }
    });
    sNext.onclick = () => tile.panel.search(sInput.value);
    sPrev.onclick = () => { tile.panel.search(sInput.value); tile.panel.findPrevious(); };
    sClose.onclick = () => { searchBar.classList.add("hidden"); tile.panel.focus(); };
    el.append(head, searchBar, mount);
```
(заменить прежний `el.append(head, mount);`). Расширить интерфейс `Tile` полем `searchBar: HTMLElement`, заполнить в объекте `tile`. Реализовать `TerminalPanel.openSearch()`? Нет — вместо этого `Deck.searchActive()` (Task 5) должен: взять активную плитку, снять `hidden` с её `searchBar`, сфокусировать input. Обновить `searchActive()`:
```ts
  searchActive() {
    const id = this.activeSession; if (!id) return;
    const t = this.tiles.get(id)!;
    t.searchBar.classList.remove("hidden");
    (t.searchBar.querySelector(".tile-search-input") as HTMLInputElement).focus();
  }
```
(и убрать из `TerminalPanel` ненужный `openSearch`, если добавляли заглушку).

- [ ] **Step 6: Стили бара поиска**

```css
.tile-search { display: flex; gap: 4px; padding: 4px 8px; background: var(--bg-panel); border-bottom: 1px solid var(--border); }
.tile-search.hidden { display: none; }
.tile-search-input { flex: 1; background: var(--bg-app); border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--fg); font: inherit; font-size: var(--fs-sm); padding: 2px 6px; outline: none; }
.tile-search-input:focus { border-color: var(--accent); }
.tile-search-btn { background: none; border: none; color: var(--fg-subtle); cursor: pointer; padding: 0 4px; }
.tile-search-btn:hover { color: var(--accent); }
```

- [ ] **Step 7: GREEN + регрессия**

Run: `npm test && npx tsc --noEmit`
Expected: `terminal-search` PASS, остальные наборы зелёные.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/terminal.ts src/sessions.ts src/styles.css tests/terminal-search.test.ts
git commit -m "feat: terminal search bar (Cmd+F) and clear via addon-search"
```

---

## Task 9: Клик уведомления → фокус (notify.ts)

**Files:**
- Create: `src/notify.ts`, `tests/notify.test.ts`
- Modify: `src/sessions.ts` (id уведомления + карта), `src/main.ts` (регистрация onAction), `src-tauri/capabilities/default.json` (разрешения окна)

**Interfaces:**
- Produces:
  - `NotifyRouter` с `register(session: string): number` (возвращает notifId, копит карту) и `resolve(notifId: number): string | null`.
  - `wireNotificationFocus(router, focus: (session: string) => void): Promise<void>` — навешивает `onAction` и при клике поднимает окно + вызывает `focus`.

- [ ] **Step 1: Падающий юнит-тест карты**

Create `tests/notify.test.ts`:
```ts
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
```

- [ ] **Step 2: RED**

Run: `npm test -- notify`
Expected: FAIL — cannot resolve `../src/notify`.

- [ ] **Step 3: Реализовать `src/notify.ts`**

```ts
import { onAction } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

export class NotifyRouter {
  private map = new Map<number, string>();
  private seq = 1;
  register(session: string): number {
    const id = this.seq++;
    this.map.set(id, session);
    return id;
  }
  resolve(notifId: number): string | null {
    return this.map.get(notifId) ?? null;
  }
}

/** Wire OS-notification clicks so they raise the window and focus the tile
 *  the notification came from. Best-effort: platforms without action routing
 *  simply won't call back. */
export async function wireNotificationFocus(
  router: NotifyRouter,
  focus: (session: string) => void,
): Promise<void> {
  await onAction((notification) => {
    const session = router.resolve(Number(notification.id));
    if (!session) return;
    const w = getCurrentWindow();
    void w.unminimize().then(() => w.show()).then(() => w.setFocus());
    focus(session);
  });
}
```
Примечание: точная форма аргумента `onAction` (наличие `notification.id`) — уточнить по API `@tauri-apps/plugin-notification`; при отличии подстроить извлечение id. Если `onAction` недоступен в установленной версии — сообщить как DONE_WITH_CONCERNS и оставить `NotifyRouter` + фокус последней ждущей как деградацию.

- [ ] **Step 4: GREEN**

Run: `npm test -- notify`
Expected: PASS (юнит-тест карты; обёртка `wireNotificationFocus` мокается/не вызывается в тесте).

- [ ] **Step 5: Присваивать id при отправке уведомления (sessions.ts)**

В `Deck` добавить поле `private notify = new NotifyRouter();` (импорт `import { NotifyRouter } from "./notify";`), и в `setState` заменить вызов `sendNotification`:
```ts
    if (state !== prev && NOTIFY_ON.includes(state) && this.notifyOk) {
      const id = this.notify.register(session);
      sendNotification({ id, title: `cowork-deck · ${LABEL[state]}`, body: tile.name });
    }
```
Добавить публичный геттер/метод, чтобы `main.ts` мог подключить маршрутизацию:
```ts
  wireNotificationFocus() {
    return wireNotificationFocus(this.notify, (s) => this.focusTile(s));
  }
```
(импорт `wireNotificationFocus` из `./notify`; `focusTile` private — вызывается изнутри, ок.)

- [ ] **Step 6: Вызвать из main.ts + разрешения окна**

В `src/main.ts` после `deck.wireEvents();` добавить `deck.wireNotificationFocus();`.
В `src-tauri/capabilities/default.json` добавить в `permissions`:
```json
    "core:window:allow-set-focus",
    "core:window:allow-show",
    "core:window:allow-unminimize"
```

- [ ] **Step 7: Проверка типов + регрессия**

Run: `npx tsc --noEmit && npm test`
Expected: без ошибок; наборы зелёные.

- [ ] **Step 8: Commit**

```bash
git add src/notify.ts tests/notify.test.ts src/sessions.ts src/main.ts src-tauri/capabilities/default.json
git commit -m "feat: route OS-notification click to raise window and focus the session (P1-4/attention)"
```

---

## Task 10: Обновить чек-лист приёмки (ручные десктоп-проверки)

**Files:**
- Modify: `docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md`

**Interfaces:**
- Consumes: результаты Задач 1-9.

- [ ] **Step 1: Прогнать полные наборы**

Run: `npm test && cargo test --manifest-path src-tauri/Cargo.toml && npx tsc --noEmit`
Expected: всё зелёное; записать сводку.

- [ ] **Step 2: Добавить раздел ручной приёмки Группы A**

В `docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md` добавить раздел:
```markdown
## Группа A «Ввод и управление» — ручная десктоп-приёмка
- [ ] Создание пространства: «+ пространство» открывает форму; «Выбрать папку…» открывает нативный диалог; имя автозаполняется из папки — требует человека
- [ ] Редактирование ✎ пространства и сценария; textarea для многострочного промпта — требует человека
- [ ] Хоткеи в живом терминале (ввод не воруется): Cmd+K палитра, Cmd+1..9 фокус, Cmd+Shift+] к ждущей, Cmd+N новая, Cmd+W закрыть, Cmd+F поиск — требует человека
- [ ] Бар поиска ищет по буферу; ⌫ очищает — требует человека
- [ ] Клик по OS-уведомлению поднимает окно и фокусирует нужную плитку (macOS/Windows; Linux — деградация) — требует человека
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md
git commit -m "docs: manual acceptance checklist for input & control (group A)"
```

---

## Self-Review Notes

- **Spec coverage:** Ф1 folder picker+формы (Tasks 1-4); Ф2 хоткеи+палитра (Tasks 5-7); Ф3 поиск/очистка (Task 8); Ф4 клик уведомления→фокус (Task 9); ручная приёмка (Task 10).
- **Порядок и заглушки:** Task 5 добавляет вызовы `panel.openSearch/clear`, которые полноценно реализуются в Task 8 — Task 5 ставит временные заглушки с комментарием `// Task 8`; Task 6 использует `openPalette` из Task 7 — временный no-op с комментарием `// Task 7`. Это допустимые межзадачные заглушки, каждая закрывается своей задачей.
- **Type consistency:** `matchHotkey`, `nextWaitingIndex`, `Command`, `pickFolder`, `workspaceForm`/`skillForm`, `NotifyRouter.register/resolve`, `TerminalPanel.search/findNext/findPrevious/clear` — имена совпадают между задачами и тестами.
- **Открытые вопросы реализации (не блокеры):** точная сигнатура `onAction`/поле `notification.id` в установленной версии plugin-notification (Task 9 Step 3 содержит инструкцию подстроиться / деградировать); точный набор `core:window:*` разрешений может отличаться по версии Tauri — сверить при Task 9.
- **Тестируемость:** чистые функции (`matchHotkey`, `nextWaitingIndex`, `filterCommands`, `NotifyRouter`) и jsdom-обёртки покрыты; нативные диалоги/фокус/клик уведомления — ручная десктоп-приёмка (Task 10), как в Release 1.0.
