// Links out of the app, and the one gate every one of them goes through.
//
// Six places used to write `a.href = url; a.target = "_blank"` and trust the
// webview to do something with it. It does not: a Tauri window has no browser
// chrome to open a second tab in, and with no URL-opening plugin registered the
// navigation was simply dropped — the button looked enabled, and clicking it did
// nothing at all (#252). The opener plugin is what actually reaches the host
// browser, and it is called from here rather than from six call sites so that
// the scheme check below cannot be forgotten at one of them.
//
// The check is not decoration. A pull request description is written by anyone
// who can open a pull request against a repository somebody added as a
// workspace, and `openUrl` hands its argument to the OS — where a `file:` URL is
// a file to open and a `javascript:` one is at the mercy of whatever the default
// handler makes of it. `http(s)` only, and the capability in
// `src-tauri/capabilities/default.json` scopes the plugin to the same two
// schemes, so a bypass here still meets a closed door.

import { openUrl } from "@tauri-apps/plugin-opener";

/** `raw` as a URL fit to hand to the OS, or null if it is not one.
 *
 *  A relative link is deliberately *not* resolved: in a pull request description
 *  it is relative to the repository, which nothing on this side knows, and
 *  guessing a base would turn `[see](../CONTRIBUTING.md)` into a link to
 *  somewhere real and wrong. Those are not URLs here, and callers show them as
 *  the text they were written as. */
export function externalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
}

/** Open `raw` in the person's own browser. Refuses anything that is not
 *  `http(s)` and never reports success — the browser comes up in front of the
 *  app, which is the feedback.
 *
 *  Both failures are warned about rather than shown: a refusal is a bug in
 *  whoever called this, and a plugin error means there is no browser to put a
 *  message in front of. */
export function openExternal(raw: string): void {
  const url = externalUrl(raw);
  if (url === null) {
    console.warn("refused to open a URL that is not http(s):", raw);
    return;
  }
  void openUrl(url).catch((e) => console.warn("could not open the browser:", url, e));
}

/** Make `a` open `url` outside the app. False means the URL was refused and the
 *  anchor was left untouched — nothing was wired, so a caller that renders the
 *  link text as plain text instead is showing the truth.
 *
 *  `href` is still set, and that is not vestigial: it is what makes this a link
 *  rather than a span that happens to be clickable. A screen reader announces it
 *  as a link, Enter activates it (as a `click`, which is why the handler is
 *  enough for the keyboard), and the context menu can copy the address. What is
 *  gone is `target`, which never did anything here. Middle click is wired
 *  separately because it arrives as `auxclick` and would otherwise ask the
 *  webview for a new window it has no way to open. */
export function wireExternal(a: HTMLAnchorElement, url: string): boolean {
  const href = externalUrl(url);
  if (href === null) return false;
  a.href = href;
  a.rel = "noreferrer";
  a.onclick = (e) => {
    e.preventDefault();
    openExternal(href);
  };
  a.onauxclick = (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openExternal(href);
  };
  return true;
}
