/* ============================================================================
   cowork-deck — the shell's one fixture, and everything derived from it
   ----------------------------------------------------------------------------
   This file exists because the shell was stating numbers in three places that
   had no common source, and they disagreed:

     · the title bar's ledger said "3 waiting for a decision" while the tree
       under it showed one waiting session and one broken one;
     · the queue's scope line said 13 cards over three groups holding 9, and two
       of the three group badges counted rows that were not there;
     · the rail's accessible names repeated both numbers a third time;
     · and activating another workspace moved a chip and rewrote two captions
       while the panel below them kept the first workspace's rows — the panel
       said "harbor" over relay's cards.

   All four are the same defect: a claim with nothing behind it. So the queue,
   the pull requests, the journal and the scenarios are ONE fixture here, the
   panel pages are rendered from it per workspace, and every count on screen is
   read off it rather than typed next to it.

   What is deliberately NOT here: the sessions. They are markup — the tree in the
   panel and the tiles in the deck are the same four sessions written once each,
   already measured in the renderer — so the ledger COUNTS the tree instead of
   restating it. One fixture per fact, wherever that fact already lives.

   A workspace has exactly one source: cards in `.cowork/tasks`, or issues in its
   repository. `relay` has cards, `harbor` has issues, and the affordances differ
   because of it — a card moves between steps, an issue is open or closed.
   ========================================================================== */
(function () {
  "use strict";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* Kind is an icon and a word, never a colour: hue belongs to state. */
  var KIND = {
    bug: "alert", spike: "flask", chore: "wrench", feature: "sparkle", docs: "book"
  };

  /* Checks have four outcomes and four different words, because "no checks
     configured" must never be able to read as "checks passed". */
  var CHECKS = {
    failed:  { cls: "checks--failed",  rail: "is-error" },
    running: { cls: "checks--running", rail: "is-waiting" },
    passed:  { cls: "checks--passed",  rail: "is-idle" },
    none:    { cls: "checks--none",    rail: "is-idle" }
  };

  var ORDER = ["relay", "harbor", "atlas"];

  var WS = {
    relay: {
      repo: "acme-labs/relay", login: "acme-dev", dir: "~/code/relay",
      source: { kind: "cards", where: ".cowork/tasks" },
      steps: [
        { name: "Backlog", open: true, next: "Todo", cards: [
          { kind: "bug", title: "Sidebar count flickers on the first paint" },
          { kind: "spike", title: "Swap the ad-hoc queue for a channel" },
          { kind: "chore", title: "Cache the git status between deck polls" },
          { kind: "feature", title: "Remember which session groups are collapsed" }
        ] },
        { name: "Todo", open: true, next: "Doing", cards: [
          { kind: "bug", title: "Board loses the label filter on a poll tick" },
          { kind: "chore", title: "Document the webhook signature scheme" },
          { kind: "feature", title: "Paginate the audit log endpoint" }
        ] },
        { name: "Shipped", open: false, next: null, cards: [
          { kind: "feature", title: "Rate-limit the export endpoint" },
          { kind: "bug", title: "Fix the flaky timer test" }
        ] }
      ],
      prs: [
        { n: 161, title: "Bump fourteen packages and green the suite", branch: "nightly-sweep",
          checks: "failed", checkText: "2 of 9 checks failed", plus: "+1,204", minus: "−988",
          files: [["package-lock.json", "+1102", "−934"], ["package.json", "+14", "−14"], ["src/deck.ts", "+88", "−40"]],
          hunk: { file: "package.json", at: "lines 18–22", lines: [
            [" ", "18", "18", '    "dependencies": {'],
            ["-", "19", "", '      "xterm": "5.3.0",'],
            ["+", "", "19", '      "@xterm/xterm": "5.5.0",'],
            ["-", "20", "", '      "xterm-addon-fit": "0.8.0",'],
            ["+", "", "20", '      "@xterm/addon-fit": "0.10.0",']
          ] } },
        { n: 158, title: "Send ESC+CR for Shift+Enter", branch: "issue-234-shift-enter",
          checks: "running", checkText: "6 of 9 checks running", plus: "+31", minus: "−4",
          files: [["src/terminal.ts", "+24", "−4"], ["tests/keys.test.ts", "+7", "−0"]],
          hunk: { file: "src/terminal.ts", at: "lines 44–47", lines: [
            [" ", "44", "44", '  if (e.key === "Enter" && e.shiftKey) {'],
            ["-", "45", "", '    pty.write("\\n");'],
            ["+", "", "45", '    pty.write("\\u001b\\r");'],
            [" ", "46", "46", "    return true;"]
          ] } },
        { n: 156, title: "Leave out a link the opener gate refused", branch: "issue-252-open-in-browser",
          checks: "passed", checkText: "9 checks passed", plus: "+63", minus: "−28",
          files: [["src/external.ts", "+41", "−18"], ["src/pr-view.ts", "+14", "−6"], ["tests/external.test.ts", "+8", "−4"]],
          hunk: { file: "src/external.ts", at: "lines 12–16", lines: [
            [" ", "12", "12", "  try {"],
            ["-", "13", "", "    return true;"],
            ["+", "", "13", "    const u = new URL(url);"],
            ["+", "", "14", '    return u.protocol === "https:";'],
            [" ", "14", "15", "  } catch {"]
          ] } },
        { n: 149, title: "Document the board's second source", branch: "docs-board-issues",
          checks: "none", checkText: "no checks configured", plus: "+22", minus: "−0",
          files: [["docs/board.md", "+22", "−0"]],
          hunk: { file: "docs/board.md", at: "lines 12–14", lines: [
            ["+", "", "12", "A workspace has exactly one source: cards in .cowork/tasks,"],
            ["+", "", "13", "or issues in its repository. Never both — a card that is"],
            ["+", "", "14", "also an issue is two truths about one task."]
          ] } }
      ],
      runs: [
        { name: "Nightly dependency sweep", when: "03:00 today", how: "scheduled", took: "21 m so far", state: "is-working", chip: "running" },
        { name: "Review the diff", when: "09:41 today", how: "by hand", took: "4 m 12 s", state: "is-done", chip: "done" },
        { name: "Nightly dependency sweep", when: "03:00 yesterday", how: "scheduled", took: "11 m 03 s", state: "is-done", chip: "done" }
      ],
      scenarios: [
        { name: "Review the diff", icon: "search" },
        { name: "Nightly dependency sweep", icon: "shield", sub: "daily 03:00 · in 4 h 12 m · 42 runs", schedule: true }
      ]
    },

    harbor: {
      repo: "acme-labs/harbor", login: "acme-release", dir: "~/code/harbor",
      source: { kind: "issues", where: "issues in acme-labs/harbor" },
      issues: [
        { n: 128, kind: "bug", title: "fix the flaky timer", sess: "s4", rail: "is-error" },
        { n: 131, kind: "bug", title: "Release tag is written before the notes exist" },
        { n: 126, kind: "chore", title: "Pin the toolchain in the release worktree" },
        { n: 119, kind: "feature", title: "Sign the release archive" },
        { n: 109, kind: "docs", title: "Document the release checklist" }
      ],
      prs: [
        { n: 74, title: "Cut 0.9.3 from the release worktree", branch: "release-0.9.3",
          checks: "passed", checkText: "7 checks passed", plus: "+96", minus: "−11",
          files: [["CHANGELOG.md", "+81", "−0"], ["Cargo.toml", "+2", "−2"], ["src-tauri/tauri.conf.json", "+13", "−9"]],
          hunk: { file: "Cargo.toml", at: "lines 3–5", lines: [
            [" ", "3", "3", '  name = "harbor"'],
            ["-", "4", "", '  version = "0.9.2"'],
            ["+", "", "4", '  version = "0.9.3"']
          ] } },
        { n: 71, title: "Pin the Rust toolchain to 1.83", branch: "pin-toolchain",
          checks: "running", checkText: "3 of 7 checks running", plus: "+9", minus: "−2",
          files: [["rust-toolchain.toml", "+4", "−0"], [".github/workflows/ci.yml", "+5", "−2"]],
          hunk: { file: "rust-toolchain.toml", at: "lines 1–3", lines: [
            ["+", "", "1", "[toolchain]"],
            ["+", "", "2", 'channel = "1.83.0"'],
            ["+", "", "3", 'components = ["clippy", "rustfmt"]']
          ] } }
      ],
      runs: [
        { name: "Write the release notes", when: "07:00 today", how: "scheduled", took: "no session started", state: "is-error", chip: "empty" }
      ],
      scenarios: [
        { name: "Write the release notes", icon: "book", sub: "daily 07:00 · in 19 h · 11 runs, 3 of them empty", schedule: true }
      ]
    },

    atlas: {
      repo: null, login: null, dir: "~/code/atlas",
      source: null, steps: [], issues: [], prs: [], runs: [], scenarios: []
    }
  };

  /* --- Counts, all read off the fixture ----------------------------------- */
  function queueCount(w) {
    if (!w.source) return 0;
    if (w.source.kind === "issues") return w.issues.length;
    var n = 0;
    w.steps.forEach(function (s) { n += s.cards.length; });
    return n;
  }
  function prsReady(w) {
    return w.prs.filter(function (p) { return p.checks === "passed"; }).length;
  }

  /* --- Scope lines: what the panel is holding, whose it is ---------------- */
  var SCOPE = {
    ws: function () {
      var g = document.querySelectorAll(".wsg").length;
      var s = document.querySelectorAll(".wsg-body .chip-state").length;
      return g + " workspaces · " + s + " sessions";
    },
    queue: function (id) {
      var w = WS[id];
      /* Not "no repository": a queue of cards needs only a folder. What atlas is
         missing is the choice of source, which is what the empty state says too. */
      if (!w.source) return id + " · no source bound";
      var n = queueCount(w);
      return id + " · " + w.source.where + " · " + n + (w.source.kind === "issues" ? " open" : " cards");
    },
    prs: function (id) {
      var w = WS[id];
      if (!w.repo) return id + " · no repository bound";
      return w.repo + " · as " + w.login + " · " + w.prs.length + " open";
    },
    log: function (id) {
      var w = WS[id];
      if (!w.scenarios.length) return id + " · no scenarios yet";
      return id + " · last 100 runs per scenario";
    },
    /* Scenarios are NOT one of the three per-repository panels — the chip on the
       current workspace names queue, pull requests and journal, and it is right.
       A scenario still BELONGS to a workspace, because it has a folder and an
       account to run under; the list is app-wide and each row says whose it is.
       Scoping this panel per workspace, as it was, made the chip a miscount. */
    scen: function () {
      var n = 0, sch = 0;
      ORDER.forEach(function (id) {
        n += WS[id].scenarios.length;
        sch += WS[id].scenarios.filter(function (s) { return s.schedule; }).length;
      });
      return n + (n === 1 ? " scenario" : " scenarios") + " · " + sch + " scheduled · every workspace";
    }
  };

  /* --- Empty states: which nothing this is -------------------------------- */
  function empty(icon, lead, rest, act, foot) {
    return '<div class="empty">'
      + '<span class="empty-mark"><i data-ic="' + icon + '"></i></span>'
      + "<p><b>" + lead + "</b> " + rest + "</p>"
      + (act ? '<div class="empty-alt"><div class="empty-alt-row">' + act + "</div>"
             + '<span class="empty-kbd">' + foot + "</span></div>" : "")
      + "</div>";
  }

  var BIND = '<button class="btn btn--quiet" data-toast="Binding a repository to atlas" data-toast-icon="folder"><i data-ic="folder"></i> Bind a repository</button>';

  /* --- The queue: two shapes, because a workspace has one source ---------- */
  function acts(inner) { return '<span class="acts">' + inner + "</span>"; }

  function cardFoot(kindIcon, kind, actions) {
    return '<span class="q-foot"><span class="chip"><i data-ic="' + kindIcon + '"></i>' + kind + "</span>"
      + '<span class="head-spacer"></span>' + actions + "</span>";
  }

  function renderQueue(id) {
    var w = WS[id];
    if (!w.source) {
      return empty("list", "No source bound.", "A queue is cards in <code>.cowork/tasks</code> or issues in a repository, and <b>atlas</b> has neither.",
        BIND, "A session can still run in atlas. Only the queue, pull requests and journal need the repository.");
    }
    if (w.source.kind === "issues") {
      var rows = w.issues.map(function (i) {
        /* An issue with a session open on it takes that session's hue and offers
           the session, not a second one: two sessions on one issue is the
           mistake this row is in a position to prevent. */
        var a = i.sess
          ? '<button class="btn--icon" data-go="' + i.sess + '" aria-label="Go to the session on issue ' + i.n + '" title="Go to the session"><i data-ic="terminal"></i></button>'
          : '<button class="btn--icon" data-toast="Session started on issue #' + i.n + '" data-toast-icon="play" aria-label="Start a session on issue ' + i.n + '"><i data-ic="play"></i></button>';
        a += '<button class="btn--icon" data-toast="Opening issue #' + i.n + ' on GitHub" data-toast-icon="external" aria-label="Open issue ' + i.n + ' on GitHub"><i data-ic="external"></i></button>';
        return '<div class="q-card rail ' + (i.rail || "is-idle") + ' disclose">'
          + '<button class="q-open"><span class="q-title">#' + i.n + " · " + esc(i.title) + "</span></button>"
          + cardFoot(KIND[i.kind], i.kind, acts(a)) + "</div>";
      }).join("");
      return '<p class="form-hint" style="padding: 0 var(--sp-2) var(--sp-2)">'
        + "<b>harbor</b> takes its queue from GitHub issues, so there are no steps to move a card between: an issue is open or it is closed. "
        + "A workspace has one source — both at once would be two truths about one task.</p>"
        + '<div class="q-step">' + rows + "</div>"
        + '<div class="empty-alt" style="border-top: 1px solid var(--line)"><div class="empty-alt-row">'
        + '<button class="btn btn--quiet" data-toast="Opening the issue list on GitHub" data-toast-icon="external"><i data-ic="external"></i> Issues on GitHub</button>'
        + '<button class="btn btn--quiet" data-open-overlay="settings"><i data-ic="sliders"></i> Source and labels</button></div>'
        + '<span class="empty-kbd">Closed issues are not drawn here: what closed them is in the journal, with the run that did it.</span></div>';
    }
    var body = w.steps.map(function (s, si) {
      var gid = "q-" + id + "-" + si;
      var cards = s.cards.map(function (c) {
        var a = '<button class="btn--icon" data-toast="Session started from this card" data-toast-icon="play" aria-label="Start a session on this card"><i data-ic="play"></i></button>';
        /* The arrow names where it goes, and it is absent when there is nowhere
           to go. An arrow that reads "move to the step you are already in" is
           the defect this rule exists for. */
        if (s.next) a += '<button class="btn--icon" data-toast="Moved to ' + s.next + '" aria-label="Move to ' + s.next + '"><i data-ic="chevron"></i></button>';
        return '<div class="q-card rail ' + (s.next ? "is-idle" : "is-done") + ' disclose">'
          + '<button class="q-open"><span class="q-title">' + esc(c.title) + "</span></button>"
          + cardFoot(KIND[c.kind], c.kind, acts(a)) + "</div>";
      }).join("");
      return '<button class="group-head" aria-expanded="' + (s.open ? "true" : "false") + '" aria-controls="' + gid + '">'
        + '<i data-ic="chevron"></i><span class="group-name">' + s.name + '</span><span class="group-badge">' + s.cards.length + "</span></button>"
        + '<div class="group-body q-step" id="' + gid + '"' + (s.open ? "" : " hidden") + ">" + cards + "</div>";
    }).join("");
    return '<p class="form-hint" style="padding: 0 var(--sp-2) var(--sp-2)">Grouped by the steps in <code>board.json</code>. “Doing” is not one of them here: it is derived from live sessions and never stored, and the deck to the right is already showing it.</p>'
      + body
      + '<div class="empty-alt" style="border-top: 1px solid var(--line)"><div class="empty-alt-row">'
      + '<button class="btn btn--quiet" id="wide-board"><i data-ic="columns"></i> The whole board, wide</button>'
      + '<button class="btn btn--quiet" data-open-overlay="settings"><i data-ic="sliders"></i> Steps and kinds</button></div>'
      + '<span class="empty-kbd">The kanban is still a kanban — an occasional wide page rather than one of four screens.</span></div>';
  }

  /* --- Pull requests ------------------------------------------------------ */
  function renderPRs(id) {
    var w = WS[id];
    if (!w.repo) {
      return empty("git-merge", "No repository bound.", "Pull requests come from the workspace’s repository and its <code>gh</code> account. <b>atlas</b> has neither.",
        BIND, "Binding one also gives atlas a queue and a journal.");
    }
    return w.prs.map(function (p) {
      var c = CHECKS[p.checks];
      return '<button class="row rail ' + c.rail + ' disclose" data-pr="' + p.n + '"><span class="row-main">'
        + '<span class="row-title">#' + p.n + " · " + esc(p.title) + "</span>"
        + '<span class="row-sub ' + c.cls + '">' + p.checkText + " · " + p.branch + "</span></span>"
        + '<i data-ic="chevron"></i></button>';
    }).join("");
  }

  function renderPRDetail(id, n) {
    var w = WS[id];
    var p = w.prs.filter(function (x) { return String(x.n) === String(n); })[0];
    if (!p) return "";
    var c = CHECKS[p.checks];
    var files = p.files.map(function (f, i) {
      return '<li><button class="file-row"' + (i === 0 ? ' aria-current="true"' : "") + '>'
        + '<span class="file-path">' + f[0] + '</span><span class="plus">' + f[1] + '</span><span class="minus">' + f[2] + "</span></button></li>";
    }).join("");
    var lines = p.hunk.lines.map(function (l) {
      var cls = l[0] === "+" ? " dv-line--add" : l[0] === "-" ? " dv-line--del" : "";
      return '<div class="dv-line' + cls + '"><span class="dv-old">' + l[1] + '</span><span class="dv-new">' + l[2] + "</span>"
        + '<span class="dv-mark">' + (l[0] === " " ? "&nbsp;" : l[0]) + '</span><span class="dv-text">' + esc(l[3]) + "</span></div>";
    }).join("");
    return '<button class="panel-back" id="pr-back"><i data-ic="chevron" class="ic ic--left"></i> All pull requests</button>'
      + '<p class="pr-title" style="font-size: var(--fs-body)">#' + p.n + " · " + esc(p.title) + "</p>"
      + '<p class="meta" style="margin-top: var(--sp-2)">'
      + '<span class="meta-item"><i data-ic="git-branch"></i>' + p.branch + " → main</span>"
      + '<span class="meta-item ' + c.cls + '"><i data-ic="' + (p.checks === "passed" ? "check" : p.checks === "failed" ? "alert" : "clock") + '"></i>' + p.checkText + "</span>"
      + '<span class="meta-item"><span class="plus">' + p.plus + '</span> <span class="minus">' + p.minus + "</span></span></p>"
      + '<ul class="pr-files" style="margin-top: var(--sp-3); max-width: none; width: auto">' + files + "</ul>"
      + '<div class="dv-file" style="margin-top: var(--sp-3)"><h4 class="dv-hunk">' + p.hunk.file + " · " + p.hunk.at + "</h4>" + lines + "</div>"
      + '<p class="form-hint" style="margin-top: var(--sp-3)">A diff wants width. Press <span class="kbd">⇧⌘→</span> or the widen button in the head: the panel takes the room from the deck, and the deck falls into the filmstrip rather than out of the window.</p>'
      + '<div class="pr-acts" style="margin-top: var(--sp-3)">'
      + '<button class="btn btn--quiet" data-toast="Opening #' + p.n + ' on GitHub" data-toast-icon="external"><i data-ic="external"></i> On GitHub</button>'
      + (p.checks === "passed"
          ? '<button class="btn btn--primary" data-toast="Squash-merged #' + p.n + '" data-toast-icon="git-merge"><i data-ic="git-merge"></i> Squash and merge</button>'
          /* Not a disabled primary: the reason it cannot merge is the sentence,
             and the action that resolves it is what gets the button. */
          : '<button class="btn btn--quiet" data-toast="Re-running the checks on #' + p.n + '" data-toast-icon="rotate"><i data-ic="rotate"></i> Re-run the checks</button>')
      + "</div>"
      + (p.checks === "passed" ? "" : '<p class="form-hint" style="margin-top: var(--sp-2)">'
          + (p.checks === "failed" ? "Merging is off the table until the two failures are dealt with, so it is not drawn as a button you may not press."
             : p.checks === "running" ? "The checks are still running. The merge button arrives when they finish, rather than sitting here greyed out."
             : "No checks are configured on this repository, which is not the same as checks passing — so merging stays a decision you make on GitHub.")
          + "</p>");
  }

  /* --- Journal and scenarios --------------------------------------------- */
  function renderLog(id) {
    var w = WS[id];
    if (!w.runs.length) {
      return empty("clock", "Nothing has run in atlas.", "The journal keeps what a scenario did, so it fills up once there is a scenario to schedule.", null, null);
    }
    return w.runs.map(function (r) {
      return '<button class="row rail ' + r.state + ' disclose"><span class="row-main">'
        + '<span class="row-title">' + esc(r.name) + "</span>"
        + '<span class="row-sub">' + r.when + " · " + r.how + " · " + r.took + "</span></span>"
        + '<span class="chip-state ' + r.state + '">' + r.chip + "</span></button>";
    }).join("")
      + '<p class="form-hint" style="padding: var(--sp-3) var(--sp-2) 0">A run’s final message is one press away, in the row. Erasing still exists at one granularity — a scenario’s history wholesale — and it lives on the scenario, not here.</p>';
  }

  /* Every workspace's scenarios, each row naming the one it runs in — the row is
     where "under which account does this push" gets answered, since firing one
     from here is the same act as starting a session by hand. */
  function renderScen() {
    var rows = "";
    ORDER.forEach(function (id) {
      WS[id].scenarios.forEach(function (s) {
        var sub = id + (s.sub ? " · " + s.sub : WS[id].login ? " · as " + WS[id].login : " · no account bound");
        rows += '<div class="row disclose"><button class="row-open" data-toast="Launched “' + esc(s.name) + '” in ' + id + '" data-toast-icon="play">'
          + '<i data-ic="' + s.icon + '"></i><span class="row-main"><span class="row-title">' + esc(s.name) + "</span>"
          + '<span class="row-sub">' + sub + "</span></span></button>"
          + '<span class="acts">'
          + (s.schedule ? '<button class="btn--icon" data-toast="Fired the run now" data-toast-icon="bolt" aria-label="Run the ' + esc(s.name) + ' schedule now"><i data-ic="clock-play"></i></button>' : "")
          + '<button class="btn--icon" data-toast="Editing “' + esc(s.name) + '”" data-toast-icon="pencil" aria-label="Edit the scenario ' + esc(s.name) + '"><i data-ic="pencil"></i></button>'
          + "</span></div>";
      });
    });
    return rows
      + '<p class="form-hint" style="padding: var(--sp-3) var(--sp-2) 0">A scenario belongs to a workspace — that is its folder and its account — but the list is not filtered to the current one: firing one is a decision about a scenario, not about which panel you are in.</p>';
  }

  /* --- The commands the new shell added, for the palette that claims to hold
         every binding in the app. It said so while missing seven of them. ---- */
  var COMMANDS = [
    ["terminal", "Workspaces and sessions, in the panel", "⌘1", "sec:ws"],
    ["list", "The queue, in the panel", "⌘2", "sec:queue"],
    ["git-merge", "Pull requests, in the panel", "⌘3", "sec:prs"],
    ["clock", "The journal, in the panel", "⌘4", "sec:log"],
    ["bolt", "Scenarios, in the panel", "⌘5", "sec:scen"],
    ["columns", "Give the panel the deck’s width", "⇧⌘→", "wide"],
    ["collapse", "Collapse the panel to its rail", "⌘B", "shut"]
  ];

  function renderCommands() {
    return '<div class="palette-group caps">Panels</div>' + COMMANDS.map(function (c) {
      return '<button class="palette-item" role="option" aria-selected="false" data-shell-cmd="' + c[3] + '" data-does="' + esc(c[1]) + '" data-icon="' + c[0] + '">'
        + '<i data-ic="' + c[0] + '"></i><span class="palette-label">' + esc(c[1]) + "</span>"
        + '<span class="palette-keys"><span class="kbd">' + c[2] + "</span></span></button>";
    }).join("");
  }

  window.deckShellData = {
    order: ORDER, ws: WS, scope: SCOPE,
    queueCount: queueCount, prsReady: prsReady,
    render: { queue: renderQueue, prs: renderPRs, prDetail: renderPRDetail, log: renderLog, scen: renderScen, commands: renderCommands }
  };
})();
