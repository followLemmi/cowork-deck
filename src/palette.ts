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
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "palette-list");
  input.placeholder = "Command…";
  const list = document.createElement("div");
  list.className = "palette-list";
  list.setAttribute("role", "listbox");
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
      // role/aria-selected + aria-activedescendant on the input: selection used
      // to be conveyed by colour alone, so arrowing through the list announced
      // nothing at all.
      el.id = `palette-item-${i}`;
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === sel));
      const label = document.createElement("span");
      label.textContent = c.title;
      el.append(label);
      if (c.hotkey) {
        const key = document.createElement("span");
        key.className = "palette-key";
        key.textContent = c.hotkey;
        el.append(key);
      }
      el.onclick = () => run(c);
      list.append(el);
    });
    input.setAttribute("aria-activedescendant", items.length ? `palette-item-${sel}` : "");
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
