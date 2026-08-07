// Экран «GitHub»: статус утилиты gh, список аккаунтов, установка и вход.
// Только рисование — вся логика в github.ts, поэтому здесь нет ни одной
// ветки, которую стоило бы покрывать юнит-тестом.
//
// Все данные попадают в DOM через textContent: имена аккаунтов и текст ошибок
// приходят извне, и innerHTML тут был бы XSS-дырой.

import { ghStatus, hostPlatform, type GhStatus } from "./ipc";
import { installCommand, scopeWarning } from "./github";

/** Минимум, который экрану нужен от деки. */
export interface CommandRunner {
  openCommandTile(titleText: string, command: string, cwd: string): void | Promise<void>;
}

function para(text: string, cls: string): HTMLElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

function notFoundBlock(
  platformCommand: string,
  deck: CommandRunner,
  cwd: string,
  close: () => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "gh-block";

  const cmd = document.createElement("input");
  cmd.className = "modal-input";
  cmd.type = "text";
  cmd.value = platformCommand;

  const run = document.createElement("button");
  run.className = "modal-ok";
  run.textContent = "Установить";
  run.onclick = () => {
    void deck.openCommandTile("установка gh", cmd.value, cwd);
    close();
  };

  const docs = document.createElement("a");
  docs.className = "gh-link";
  docs.href = "https://github.com/cli/cli#installation";
  docs.target = "_blank";
  docs.rel = "noreferrer";
  docs.textContent = "Поставлю сам — открыть инструкцию";

  wrap.append(
    para(
      "GitHub CLI (gh) не найден. Без него воркспейс нельзя привязать к аккаунту — " +
        "всё остальное в приложении работает как обычно.",
      "gh-note",
    ),
    cmd,
    para(
      "Команду можно поправить перед запуском — она выполнится в обычном тайле-терминале, " +
        "и её вывод будет виден целиком.",
      "gh-hint",
    ),
    run,
    docs,
  );
  return wrap;
}

function foundBlock(
  status: GhStatus,
  deck: CommandRunner,
  cwd: string,
  close: () => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "gh-block";
  wrap.append(para(`${status.version ?? "gh"} — ${status.path}`, "gh-note"));

  if (status.error) {
    // A failed listing is not "no accounts" — say what gh actually answered,
    // or the user with two accounts stares at an inexplicably empty list.
    wrap.append(para(`gh could not list accounts: ${status.error}`, "gh-error"));
  } else if (!status.accounts.length) {
    wrap.append(para("Аккаунтов нет. Добавьте первый — вход проходит в терминале.", "gh-note"));
  }

  for (const a of status.accounts) {
    const row = document.createElement("div");
    row.className = "gh-acc-row";

    const name = document.createElement("span");
    name.className = "gh-acc-login";
    name.textContent = a.active ? `${a.login} · активный в gh` : a.login;

    const meta = document.createElement("span");
    meta.className = "gh-acc-meta";
    meta.textContent = a.state === "success" ? a.scopes.join(", ") : `состояние: ${a.state}`;

    row.append(name, meta);

    const warn = scopeWarning(a);
    if (warn) {
      const w = document.createElement("span");
      w.className = "gh-acc-warn";
      w.textContent = warn;
      row.append(w);
    }
    wrap.append(row);
  }

  const add = document.createElement("button");
  add.className = "modal-ok";
  add.textContent = "Добавить аккаунт";
  add.onclick = () => {
    // Device-flow пользователь проходит сам; токен через приложение не идёт.
    void deck.openCommandTile("вход в GitHub", "gh auth login", cwd);
    close();
  };
  wrap.append(add);
  return wrap;
}

/** Открывает экран. Скан gh — при открытии и по кнопке «Перечитать»;
 *  фонового опроса нет сознательно. */
export async function openGithubScreen(deck: CommandRunner, cwd = "."): Promise<void> {
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box gh-screen";
  ov.append(box);
  document.body.append(ov);

  const close = () => ov.remove();
  ov.addEventListener("mousedown", (e) => {
    if (e.target === ov) close();
  });

  const render = async () => {
    box.replaceChildren();
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "GitHub";
    box.append(title);

    let body: HTMLElement;
    try {
      const status = await ghStatus();
      body = status.path
        ? foundBlock(status, deck, cwd, close)
        : notFoundBlock(installCommand(await hostPlatform()), deck, cwd, close);
    } catch (e) {
      body = para(`не удалось опросить gh: ${String((e as { message?: string })?.message ?? e)}`, "gh-note");
    }
    box.append(body);

    const reload = document.createElement("button");
    reload.className = "modal-cancel";
    reload.textContent = "Перечитать";
    reload.onclick = () => void render();
    const done = document.createElement("button");
    done.className = "modal-ok";
    done.textContent = "Готово";
    done.onclick = close;
    const row = document.createElement("div");
    row.className = "modal-actions";
    row.append(reload, done);
    box.append(row);
  };

  await render();
}
