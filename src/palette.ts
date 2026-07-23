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
      el.onclick = () => run(c);
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
