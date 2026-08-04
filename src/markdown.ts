// Markdown, rendered to DOM nodes rather than to a string of HTML.
//
// `pr-view.ts` used to show a pull request description in a `<pre>`, as written,
// with a comment saying the two honest options were plain text and a dependency —
// and that a hand-rolled subset turning `[x](javascript:…)` into an anchor was not a
// third. That was right about the danger and wrong about the count: **there is a
// third, and this is it.** Take a real parser's token stream and build the tree with
// `createElement` and `textContent`.
//
// The distinction is the whole security argument. A renderer that produces an HTML
// string needs a sanitiser, and the sanitiser is then the only thing standing between
// a pull request description and this window — a window that can call `invoke`, so
// "it is only a comment" is not true here. Anyone who can open a pull request against
// a repository somebody has added as a workspace writes this text.
//
// Building nodes has no such gap. `textContent` cannot produce an element, so inline
// HTML in the source is not "stripped" or "escaped" — it is never markup in the first
// place. `<img src=x onerror=…>` arrives at the screen as those characters, which is
// exactly what it did in the `<pre>`. There is no configuration to get wrong and
// nothing to keep up to date.
//
// The one place a hostile input can still reach an API is a URL, and there is exactly
// one gate for it: `safeHref`. Read that before changing anything here.

import { lexer, type Token, type Tokens } from "marked";

/** Where a heading in a description starts.
 *
 *  The pull request screen's own title is an `<h3>` (`pr-view.ts`), and a description
 *  is content *under* a row on that screen — so its `#` must not outrank the screen
 *  it sits in. `#` becomes `<h4>` and everything deeper is clamped at `<h6>`.
 *  Flattening them all to one level instead would cost a screen-reader user the
 *  heading structure, which in a long description is the only way to skim. */
const HEADING_BASE = 3;

/** The only protocols an anchor may carry.
 *
 *  A relative link is deliberately *not* resolved: in a description it is relative to
 *  the repository, which this module has no way to know, and guessing a base would
 *  turn `[see](../CONTRIBUTING.md)` into a link to somewhere real and wrong. Those
 *  render as plain text — visible, honest, and not clickable. */
function safeHref(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inline tokens into `parent`.
 *
 *  Every branch either creates an element and recurses, or appends a text node.
 *  There is no branch that assigns markup, and adding one would defeat the module. */
function inline(parent: Node, tokens: Token[] | undefined, raw: string): void {
  // `marked` leaves `tokens` off a plain text run. Its `raw` is the text.
  if (!tokens) {
    parent.appendChild(document.createTextNode(raw));
    return;
  }
  for (const t of tokens) {
    switch (t.type) {
      case "strong": {
        const n = el("strong");
        inline(n, (t as Tokens.Strong).tokens, t.raw);
        parent.appendChild(n);
        break;
      }
      case "em": {
        const n = el("em");
        inline(n, (t as Tokens.Em).tokens, t.raw);
        parent.appendChild(n);
        break;
      }
      case "del": {
        const n = el("del");
        inline(n, (t as Tokens.Del).tokens, t.raw);
        parent.appendChild(n);
        break;
      }
      case "codespan":
        parent.appendChild(el("code", "md-code", (t as Tokens.Codespan).text));
        break;
      case "br":
        parent.appendChild(el("br"));
        break;
      case "link": {
        const lt = t as Tokens.Link;
        const href = safeHref(lt.href);
        if (href === null) {
          // Not silently dropped: the link text is still what the author wrote, and
          // deleting it would leave a sentence with a hole in it.
          inline(parent, lt.tokens, lt.raw);
          break;
        }
        const a = el("a", "md-link");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        inline(a, lt.tokens, lt.raw);
        parent.appendChild(a);
        break;
      }
      case "image": {
        // Deliberately never an `<img>`. Rendering one makes the app fetch an
        // arbitrary URL the moment a row is expanded, which turns opening a pull
        // request into a request to whoever wrote it — a tracking pixel at best.
        // The alt text and a link to the source say the same thing without the
        // network call.
        const it = t as Tokens.Image;
        const href = safeHref(it.href);
        const label = it.text || "image";
        if (href === null) {
          parent.appendChild(document.createTextNode(`[${label}]`));
          break;
        }
        const a = el("a", "md-link", `[${label}]`);
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.title = "Image — opens in a browser";
        parent.appendChild(a);
        break;
      }
      // `html` lands here for inline markup, and this is the case the whole module
      // exists for: it is appended as characters, exactly as the `<pre>` used to.
      case "html":
      case "text":
      case "escape":
      default: {
        const withTokens = t as { tokens?: Token[] };
        if (t.type === "text" && withTokens.tokens) inline(parent, withTokens.tokens, t.raw);
        else parent.appendChild(document.createTextNode((t as Tokens.Text).text ?? t.raw));
        break;
      }
    }
  }
}

function list(t: Tokens.List): HTMLElement {
  const node = t.ordered ? el("ol", "md-list") : el("ul", "md-list");
  // A description that numbers its steps from 3 means it; `<ol>` would restart at 1.
  if (node instanceof HTMLOListElement && typeof t.start === "number" && t.start !== 1) {
    node.start = t.start;
  }
  for (const item of t.items) {
    const li = el("li", "md-item");
    if (item.task) {
      // A real checkbox, disabled: a description's task list is a record, not a
      // control, and one that looked operable here would promise a write this
      // screen cannot perform.
      const box = el("input", "md-task");
      box.type = "checkbox";
      box.checked = item.checked ?? false;
      box.disabled = true;
      box.setAttribute("aria-label", item.checked ? "done" : "not done");
      li.appendChild(box);
    }
    blocks(li, item.tokens);
    node.appendChild(li);
  }
  return node;
}

function table(t: Tokens.Table): HTMLElement {
  // The reason a Markdown renderer was worth having at all: an ASCII table in a
  // proportional face is noise, and the `<pre>` could only keep it legible by holding
  // the whole description in a fixed pitch at 80 columns.
  const wrap = el("div", "md-table-wrap");
  const node = el("table", "md-table");
  const thead = el("thead");
  const hr = el("tr");
  t.header.forEach((cell, i) => {
    const th = el("th");
    if (t.align[i]) th.style.textAlign = t.align[i]!;
    inline(th, cell.tokens, cell.text);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  node.appendChild(thead);
  const tbody = el("tbody");
  for (const row of t.rows) {
    const tr = el("tr");
    row.forEach((cell, i) => {
      const td = el("td");
      if (t.align[i]) td.style.textAlign = t.align[i]!;
      inline(td, cell.tokens, cell.text);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  node.appendChild(tbody);
  wrap.appendChild(node);
  return wrap;
}

function blocks(parent: Node, tokens: Token[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const ht = t as Tokens.Heading;
        const level = Math.min(6, HEADING_BASE + ht.depth);
        const n = el(`h${level}` as "h4", "md-head");
        inline(n, ht.tokens, ht.raw);
        parent.appendChild(n);
        break;
      }
      case "paragraph": {
        const n = el("p", "md-p");
        inline(n, (t as Tokens.Paragraph).tokens, t.raw);
        parent.appendChild(n);
        break;
      }
      case "code": {
        // `lang` is not honoured — there is no syntax highlighting here, for the
        // reason recorded in the diff drawer design: a theme is ten colours that each
        // need measuring against every background they land on.
        const pre = el("pre", "md-pre");
        pre.appendChild(el("code", undefined, (t as Tokens.Code).text));
        parent.appendChild(pre);
        break;
      }
      case "blockquote": {
        const n = el("blockquote", "md-quote");
        blocks(n, (t as Tokens.Blockquote).tokens);
        parent.appendChild(n);
        break;
      }
      case "list":
        parent.appendChild(list(t as Tokens.List));
        break;
      case "table":
        parent.appendChild(table(t as Tokens.Table));
        break;
      case "hr":
        parent.appendChild(el("hr", "md-hr"));
        break;
      case "space":
        break;
      // marked puts the task marker in the item's token list as well as on the item
      // itself, so the raw `[x] ` is here and would reach the screen through the
      // default branch. `list` below builds the real input from `item.task`; this is
      // the same information arriving twice, and the text form is the wrong one.
      case "checkbox":
        break;
      // A `text` token in block position is what a *tight* list item is made of, and
      // its children are **inline** tokens. Recursing into `blocks` for them — which
      // is what the default branch below would do — turns every `strong`, `codespan`
      // and run of plain text in a bullet into a block of its own: one bullet becomes
      // four stacked lines and an inline `code` span comes out as literal backticks.
      // Measured in the harness before this case existed. A loose list is different:
      // marked emits `paragraph` there, which the case above already handles.
      case "text":
        inline(parent, (t as Tokens.Text).tokens, t.raw);
        break;
      // Block-level raw HTML, same rule as the inline case: characters, never markup.
      // A `<details>` block in a description reads as its own source, which is worse
      // than GitHub renders it and better than any amount of sanitiser configuration.
      case "html":
        parent.appendChild(el("p", "md-raw", t.raw.trim()));
        break;
      default: {
        const withTokens = t as { tokens?: Token[] };
        if (withTokens.tokens) blocks(parent, withTokens.tokens);
        else if (t.raw.trim()) parent.appendChild(el("p", "md-p", t.raw));
        break;
      }
    }
  }
}

/** Parse Markdown and return it as nodes.
 *
 *  Pure apart from `document.createElement`, and returns a fragment rather than
 *  mounting anywhere, so a caller decides where it goes and the tests can count nodes
 *  without a screen. */
export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  blocks(frag, lexer(src));
  return frag;
}
