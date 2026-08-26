// The GitHub screen: whether gh is installed, which accounts it knows, and the
// two things a person can do about either — install it, or sign one in.
//
// Drawing only. Every decision lives in github.ts, which is why there is not one
// branch here worth a unit test of its own.
//
// Everything reaches the DOM through `textContent`: account logins and error text
// both come from outside this app, and `innerHTML` here would be an XSS hole.

import { wireExternal } from "./external";
import { ghStatus, hostPlatform, type GhStatus } from "./ipc";
import { installCommand, scopeWarning } from "./github";

/** The least this screen needs from the deck. */
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
  run.textContent = "Install";
  run.onclick = () => {
    void deck.openCommandTile("installing gh", cmd.value, cwd);
    close();
  };

  const docs = document.createElement("a");
  docs.className = "gh-link";
  docs.textContent = "I will install it myself — open the instructions";
  // Through the opener plugin, like every other link out of the app: this window
  // has nowhere to navigate a `_blank` to (see `external.ts`).
  wireExternal(docs, "https://github.com/cli/cli#installation");

  wrap.append(
    para(
      "GitHub CLI (gh) not found. Without it a workspace cannot be bound to an " +
        "account — everything else in the app works as usual.",
      "gh-note",
    ),
    cmd,
    para(
      "The command can be edited before it runs — it runs in an ordinary terminal " +
        "tile, and all of its output is there to read.",
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
    wrap.append(para("No accounts. Add the first — signing in happens in the terminal.", "gh-note"));
  }

  for (const a of status.accounts) {
    const row = document.createElement("div");
    row.className = "gh-acc-row";

    const name = document.createElement("span");
    name.className = "gh-acc-login";
    name.textContent = a.active ? `${a.login} · active in gh` : a.login;

    const meta = document.createElement("span");
    meta.className = "gh-acc-meta";
    meta.textContent = a.state === "success" ? a.scopes.join(", ") : `state: ${a.state}`;

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
  add.textContent = "Add an account";
  add.onclick = () => {
    // The device flow is the person's to complete; no token passes through the app.
    void deck.openCommandTile("signing in to GitHub", "gh auth login", cwd);
    close();
  };
  wrap.append(add);
  return wrap;
}

/** Open the screen. gh is scanned when it opens and when "Read again" is pressed;
 *  there is deliberately no background poll. */
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
      body = para(`could not ask gh: ${String((e as { message?: string })?.message ?? e)}`, "gh-note");
    }
    box.append(body);

    const reload = document.createElement("button");
    reload.className = "modal-cancel";
    reload.textContent = "Read again";
    reload.onclick = () => void render();
    const done = document.createElement("button");
    done.className = "modal-ok";
    done.textContent = "Done";
    done.onclick = close;
    const row = document.createElement("div");
    row.className = "modal-actions";
    row.append(reload, done);
    box.append(row);
  };

  await render();
}
