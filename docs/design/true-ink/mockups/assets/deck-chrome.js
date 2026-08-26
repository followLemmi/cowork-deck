/* The application shell — the title bar, the sidebar and the command palette,
 * written once and rendered into every screen.
 *
 * Why not five copies of the markup: the shell being identical across views is
 * not a convenience, it is one of the things this redesign is FOR. The old app
 * drifted — the workspace chip existed in the mockups and not in the product,
 * the sidebar's three panels were three separate mounts — and a shell that
 * cannot drift is worth more than a shell you can read inline. Every node it
 * emits carries its `data-od-id`, so the rendered document is as inspectable as
 * a hand-written one.
 *
 * Runs BEFORE icons.js, whose `[data-ic]` hydration then reaches this markup.
 */
(function () {
  "use strict";

  var TABS = [
    { id: "terminals", href: "terminals-deck.html", icon: "terminal", label: "Terminals", badge: "1", badgeTitle: "1 session is waiting for a decision" },
    { id: "board", href: "board.html", icon: "list", label: "Board" },
    { id: "pull-requests", href: "pull-requests.html", icon: "git-merge", label: "Pull requests" },
    { id: "history", href: "history.html", icon: "clock", label: "History" }
  ];

  var WORKSPACES = [
    { id: "relay", login: "acme-dev", state: "is-working", hue: "var(--st-working)", sub: "acme-dev · 12 today", source: "cards" },
    { id: "harbor", login: "acme-release", state: "is-waiting", hue: "var(--st-waiting)", sub: "acme-release · 14 today", source: "issues" },
    { id: "atlas", login: null, state: "is-idle", hue: "var(--fg-dim)", sub: "no account bound", source: "cards" }
  ];

  var SESSIONS = [
    { ws: "relay", rows: [
      { name: "Retry the refund webhook on a 410", state: "is-working", chip: "working", key: "s1" },
      { name: "Review the diff", state: "is-waiting", chip: "needs input", key: "s2" },
      { name: "Nightly dependency sweep", state: "is-done", chip: "done", key: "s3" }
    ] },
    { ws: "harbor", rows: [
      { name: "#128 · fix the flaky timer", state: "is-error", chip: "error", key: "s4" }
    ] }
  ];

  var SCENARIOS = [
    { name: "Review the diff", icon: "search", sub: null, schedule: false },
    { name: "Nightly dependency sweep", icon: "shield", sub: "daily 03:00 · in 4 h 12 m", schedule: true },
    { name: "Write the release notes", icon: "book", sub: null, schedule: false }
  ];

  var COMMANDS = [
    ["Sessions", [
      ["plus", "New session", "⌘N", "A new session in relay"],
      ["expand", "Zoom the active session", "⌘↵", "Zoom the active session"],
      ["pencil", "Rename the active session", "F2", "Rename the active session"],
      ["broadcast", "Broadcast input to several sessions", "⌘⇧B", "Broadcast is on"],
      ["rotate", "Restart and resume the active session", null, "Restarting with claude --resume"]
    ]],
    ["Board and pull requests", [
      ["list", "File a task card", "⌘⇧T", "Filing a card"],
      ["git-merge", "Refresh pull requests", "⌘R", "Refreshing pull requests"],
      ["wrap", "Wrap long lines in the diff", null, "Long lines wrap"]
    ]],
    ["Appearance", [
      ["sun", "Switch between the light and dark appearance", null, "Appearance switched"],
      ["sliders", "Text size", null, "Text size"]
    ]]
  ];

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function barHTML(screen, ws) {
    var tabs = TABS.map(function (t) {
      var on = t.id === screen;
      return '<a class="tab" href="' + t.href + '" data-od-id="tab-' + t.id + '"' + (on ? ' aria-current="page"' : "") + '>'
        + '<i data-ic="' + t.icon + '"></i><span class="tab-label">' + t.label + "</span>"
        + (t.badge ? '<span class="tab-badge" title="' + esc(t.badgeTitle) + '">' + t.badge + "</span>" : "")
        + "</a>";
    }).join("");
    return '<header class="bar" data-od-id="titlebar">'
      + '<div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>'
      + '<div class="mark"><span class="mark-glyph" data-app-mark aria-hidden="true"></span>'
      + '<span class="mark-text">cowork<span>·deck</span></span></div>'
      + '<nav class="tabs" aria-label="Views" data-od-id="view-tabs">' + tabs + '<span class="tabs-ink" aria-hidden="true"></span></nav>'
      + '<span class="bar-spacer"></span>'
      /* The active workspace as a PATH. "Which account am I about to push as" was
         a question the old sidebar answered only if you scrolled to it. */
      + '<button class="crumb" data-od-id="workspace-crumb" data-toast="Workspace switcher" data-toast-icon="folder">'
      + '<span class="dot" style="background: ' + ws.hue + '"></span><span class="crumb-name">' + ws.id + "</span>"
      + (ws.login ? '<span class="crumb-sep">/</span><span class="crumb-login">' + ws.login + "</span>" : '<span class="crumb-login">no account</span>')
      + '<i data-ic="chevron" class="ic ic--down"></i></button>'
      + '<div class="bar-acts" data-od-id="global-actions">'
      + '<button class="btn--icon" data-open-overlay="palette" aria-label="Find a command (⌘K)" title="Find a command (⌘K)"><i data-ic="search"></i></button>'
      + '<button class="btn--icon" data-theme-toggle aria-label="Switch appearance"><i data-ic="moon"></i></button>'
      + '<button class="btn--icon" data-open-overlay="settings" aria-label="Settings" title="Settings"><i data-ic="sliders"></i></button>'
      + "</div></header>";
  }

  function sideHTML(current) {
    var ws = WORKSPACES.map(function (w) {
      var on = w.id === current;
      return '<div class="row rail ' + w.state + (on ? " is-selected" : "") + ' disclose" data-od-id="ws-row-' + w.id + '" data-ws="' + w.id + '">'
        + '<button class="row-open"' + (on ? ' aria-current="true"' : "") + '>'
        + '<span class="dot" style="background: ' + w.hue + '"></span>'
        + '<span class="row-main"><span class="row-title">' + w.id + '</span><span class="row-sub">' + esc(w.sub) + "</span></span></button>"
        /* One action on the row, and it is the reversible one. Removing a
           workspace lives inside the edit dialog: it is rare, it is
           irreversible, and a hover row is the wrong place to keep either. That
           also gives the names back the 28px the trash can was holding. */
        + '<span class="acts">'
        + '<button class="btn--icon" data-toast="Editing the workspace ' + w.id + '" data-toast-icon="pencil" aria-label="Edit the workspace ' + w.id + ', including removing it"><i data-ic="pencil"></i></button>'
        + "</span></div>";
    }).join("");

    var sc = SCENARIOS.map(function (s) {
      return '<div class="row disclose" data-od-id="scenario-row">'
        + '<button class="row-open" data-toast="Launched “' + esc(s.name) + '”" data-toast-icon="play">'
        + '<i data-ic="' + s.icon + '"></i><span class="row-main"><span class="row-title">' + esc(s.name) + "</span>"
        + (s.sub ? '<span class="row-sub">' + esc(s.sub) + "</span>" : "") + "</span></button>"
        + '<span class="acts">'
        + (s.schedule ? '<button class="btn--icon" data-toast="Fired the 03:00 run now" data-toast-icon="bolt" aria-label="Run this schedule now"><i data-ic="clock-play"></i></button>' : "")
        + '<button class="btn--icon" data-toast="Editing “' + esc(s.name) + '”" data-toast-icon="pencil" aria-label="Edit the scenario ' + esc(s.name) + '"><i data-ic="pencil"></i></button>'
        + "</span></div>";
    }).join("");

    var groups = SESSIONS.map(function (g) {
      var rows = g.rows.map(function (r) {
        return '<button class="row rail ' + r.state + ' disclose" data-session="' + r.key + '" data-od-id="session-row-' + r.key + '">'
          + '<span class="row-main"><span class="row-title">' + esc(r.name) + "</span></span>"
          + '<span class="chip-state ' + r.state + '" data-session-chip="' + r.key + '">' + r.chip + "</span></button>";
      }).join("");
      return '<button class="group-head" aria-expanded="true" aria-controls="grp-' + g.ws + '">'
        + '<i data-ic="chevron"></i><span class="group-name">' + g.ws + '</span><span class="group-badge">' + g.rows.length + "</span></button>"
        + '<div class="group-body" id="grp-' + g.ws + '">' + rows + "</div>";
    }).join("");

    return '<aside class="side" data-od-id="sidebar"><div class="side-scroll">'
      + '<section class="sec" data-od-id="sidebar-workspaces"><div class="sec-head"><span class="caps">Workspaces</span>'
      + '<button class="btn--icon" data-toast="New workspace" data-toast-icon="plus" aria-label="Add a workspace"><i data-ic="plus"></i></button></div>'
      + ws + "</section>"
      + '<section class="sec" data-od-id="sidebar-scenarios"><div class="sec-head"><span class="caps">Scenarios</span>'
      + '<button class="btn--icon" data-toast="New scenario" data-toast-icon="plus" aria-label="Add a scenario"><i data-ic="plus"></i></button></div>'
      + sc + "</section>"
      + '<section class="sec" data-od-id="sidebar-sessions"><div class="sec-head"><span class="caps">Sessions</span>'
      + '<span class="sec-note">↑157.1k ↓18.0k</span></div>' + groups + "</section>"
      + "</div>"
      + '<div class="side-foot" data-od-id="sidebar-footer">'
      + '<button class="btn btn--primary" data-toast="A new session in ' + current + '" data-toast-icon="plus" data-od-id="new-session"><i data-ic="plus"></i> New session</button>'
      + '<span class="side-hint">or <span class="kbd">⌘N</span> · broadcast <span class="kbd">⌘⇧B</span></span>'
      + "</div></aside>";
  }

  function paletteHTML() {
    var n = 0;
    var body = COMMANDS.map(function (grp) {
      return '<div class="palette-group caps">' + grp[0] + "</div>" + grp[1].map(function (c) {
        n++;
        return '<button class="palette-item" role="option" aria-selected="' + (n === 1) + '" data-does="' + esc(c[3]) + '" data-icon="' + c[0] + '">'
          + '<i data-ic="' + c[0] + '"></i><span class="palette-label">' + esc(c[1]) + "</span>"
          + (c[2] ? '<span class="palette-keys"><span class="kbd">' + c[2] + "</span></span>" : "") + "</button>";
      }).join("");
    }).join("");
    return '<div class="overlay" id="palette" hidden><div class="palette pop" role="dialog" aria-modal="true" aria-label="Command palette" data-od-id="command-palette">'
      + '<div class="palette-search"><i data-ic="search"></i>'
      + '<input type="text" placeholder="Run a command…" data-autofocus aria-label="Run a command"><span class="kbd">esc</span></div>'
      + '<div class="palette-list" role="listbox" aria-label="Commands">' + body
      /* An empty result says which nothing it is. "No results" on a palette that
         lists every binding in the app is a smaller fact than it looks. */
      + '<p class="palette-empty" hidden>Nothing matches that. Every binding in the app is in this list — a command missing here is missing from the app.</p>'
      + "</div>"
      + '<div class="palette-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> to move</span>'
      + '<span><span class="kbd">↵</span> to run</span><span class="bar-spacer"></span><span>' + n + " commands</span></div>"
      + "</div></div>";
  }

  function settingsHTML() {
    return '<div class="overlay" id="settings" hidden><div class="modal pop" role="dialog" aria-modal="true" aria-labelledby="set-t" data-od-id="settings-dialog">'
      + '<div class="modal-head"><h2 class="modal-title" id="set-t">Settings</h2></div>'
      + '<div class="modal-body">'
      + '<div class="fieldset"><div class="fieldset-head"><span class="caps">Appearance</span></div>'
      + '<div class="form-row"><span class="form-label">Theme</span>'
      + '<div class="filters" role="group" aria-label="Theme"><button class="filter" data-set-theme="dark">Dark</button>'
      + '<button class="filter" data-set-theme="light">Light</button></div>'
      + '<p class="form-hint">The terminal stays dark in both. It is a window onto another program, and its ANSI palette is not ours to relight.</p></div>'
      + '<div class="form-row"><label class="form-label" for="set-scale">Text size</label>'
      + '<input class="field" id="set-scale" type="range" min="85" max="130" value="100" aria-describedby="set-scale-h">'
      + '<p class="form-hint" id="set-scale-h">100% is the size the app ships at. Hit targets stay in CSS pixels, so they do not shrink with it.</p></div></div>'
      + '<div class="fieldset"><div class="fieldset-head"><span class="caps">Notifications</span></div>'
      + '<label class="check"><input type="checkbox" checked><span class="check-text">Notify when a session needs a decision</span>'
      + '<span class="check-hint">Clicking the notification focuses that session.</span></label>'
      + '<label class="check"><input type="checkbox" checked><span class="check-text">Notify when a session finishes a turn</span>'
      + '<span class="check-hint">Separate on purpose: an interactive claude parks at the prompt when it is done, which is not the same as being blocked.</span></label>'
      + '<label class="check"><input type="checkbox"><span class="check-text">Keep the floating pill on top</span></label></div>'
      + "</div>"
      + '<div class="modal-acts"><button class="btn btn--quiet" data-close-overlay>Cancel</button>'
      + '<button class="btn btn--primary" data-close-overlay data-toast="Settings saved">Save</button></div>'
      + "</div></div>";
  }

  var body = document.body;
  var screen = body.getAttribute("data-screen") || "terminals";
  var wsId = body.getAttribute("data-workspace") || "relay";
  var ws = WORKSPACES.filter(function (w) { return w.id === wsId; })[0] || WORKSPACES[0];

  var slot = document.querySelector("[data-shell]");
  if (slot) {
    var main = slot.innerHTML;
    slot.innerHTML = barHTML(screen, ws) + '<div class="stage">' + sideHTML(wsId) + main + "</div>";
  }
  document.body.insertAdjacentHTML("beforeend", paletteHTML() + settingsHTML());

  /* The theme buttons in Settings are a second face of the same control as the
     one in the title bar, so they read the same state rather than keeping their
     own. */
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-set-theme]");
    if (!b) return;
    var want = b.getAttribute("data-set-theme");
    var now = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    if (want !== now) document.querySelector("[data-theme-toggle]").click();
  });
  function syncTheme() {
    var now = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    Array.prototype.forEach.call(document.querySelectorAll("[data-set-theme]"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-set-theme") === now));
    });
  }
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  syncTheme();
})();
