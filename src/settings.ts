// Settings: a rail of sections and one pane.
//
// It was two groups of fields in one scroll, and the second was not a preference
// at all — "where is my configuration, and what is this workspace bound to" is a
// question, and answering it is worth more than a window that only lets things be
// changed. Adding the config repository to that scroll is what broke it: three
// groups of fields in a column with no navigation is not a window, it is a page.
//
// So: a section is ONE ROW in the rail and ONE PANE beside it. That is the whole
// extensibility claim, and it is deliberately boring — nothing about the rail or
// the pane changes as sections are added, and `SECTIONS` below is the only list
// anybody has to touch. The order is "often and harmless" to "rarely and with
// consequences".
//
// THERE IS NO OK BUTTON. Every section here applies as it is touched: the text
// size previews live, because a chooser that only takes effect on OK asks a person
// to imagine the result of each option, which is what they opened it to stop
// doing — and connecting a repository cannot be undone by a Cancel at all. A
// button that promised either would be lying, so there is one quiet Done.
//
// It stays a modal rather than becoming a screen or a second OS window. A screen
// would need a page in the panel, and the panel's pages are things you WORK in;
// settings is a thing you visit. A second window would need its own entry point,
// its own stylesheet copy (see `pill.css`) and a story for what happens when the
// main window closes under it.

import { openDialog } from "./dialog-shell";
import { syncQuestions, syncSummary } from "./ipc";
import { labeledCheck } from "./forms";
import { mountRooms } from "./diary-rooms";
import { mountSync } from "./sync-dialog";
import { applyScale, currentScale, scaleLabel, SCALE_STEPS } from "./ui-scale";
import type { ConfigPaths, Workspace } from "./ipc";

/** Which pane is showing. A union rather than a string so a caller cannot open a
 *  section that does not exist — the palette opens this window straight at the
 *  config repository, and a typo there would land on a blank pane. */
export type SettingsSection = "appearance" | "scenarios" | "notes" | "config" | "files";

/** Everything the window shows that it does not own.
 *
 *  Passed in rather than read here, and the reason is the one this module has
 *  always followed: it owns a dialog, not the app's state. The paths come from
 *  Rust, the workspace from the panel, and the actions are the caller's —
 *  `revealPath`, the workspace form and the scale's own persistence all exist
 *  elsewhere and none of them belongs to a preferences window. */
export interface SettingsInput {
  paths: ConfigPaths | null;
  workspace: Workspace | null;
  /** What this workspace's tasks come from, in words — "cards in .cowork/tasks",
   *  "issues in acme-labs/relay". Resolved by the caller, which owns the tracker
   *  vocabulary. */
  taskSource: string | null;
  onReveal: (path: string) => void;
  onEditWorkspace: () => void;
  /** Applied and persisted the moment it is picked. There is no OK to wait for. */
  onScale: (scale: number) => void;
  /** Whether a scenario's runs are written to the journal. Read here and written
   *  back through `onRecording`; the value itself lives in `ui_state`. */
  recording: boolean;
  /** Same contract as `onScale`: applied and persisted on the spot. */
  onRecording: (on: boolean) => void;
  /** Whether the app may ask a connected AI what the account has left, as
   *  opposed to only counting what it can see for itself. The capability flag
   *  #306 landed behind; the value lives in `ui_state`. */
  reportedLimits: boolean;
  /** Same contract as `onScale`: applied and persisted on the spot. */
  onReportedLimits: (on: boolean) => void;
  /** Whether closing a session writes a note about it. `undefined` is "never
   *  asked", and it is a third state rather than a missing boolean: the control
   *  below offers all three, because "ask me each time" is a real answer and not
   *  the absence of one. */
  captureOnClose: boolean | undefined;
  /** `undefined` puts it back to being asked each time. Same contract as
   *  `onScale`: applied and persisted on the spot. */
  onCaptureOnClose: (value: boolean | undefined) => void;
  /** Which section to land on. Defaults to the first. */
  section?: SettingsSection;
}

interface Section {
  id: SettingsSection;
  /** The rail's word for it. */
  label: string;
  /** The pane's own heading, and one line under it saying what this section is
   *  for. Not a tooltip: a person is already looking at the pane. */
  title: string;
  blurb: string;
  /** Fill the pane. `close` is for the one action that hands over to another
   *  window — two modals on one subject is a stack nobody asked for. Returns a
   *  teardown when it has one to do. */
  fill: (body: HTMLElement, input: SettingsInput, close: () => void) => (() => void) | void;
}

/** Open it. Resolves when the window closes. */
export function settingsDialog(input: SettingsInput): Promise<void> {
  return new Promise((resolve) => {
    const teardowns: (() => void)[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const t of teardowns) t();
      closeDialog();
      resolve();
    };

    const { box, close: closeDialog } = openDialog({
      onCancel: finish,
      /* Enter does nothing. It would otherwise close the window from inside a
         field where Enter means "create this repository" — and closing is not what
         that keystroke was for. Esc, the scrim and Done are the ways out. */
      onAccept: () => {},
      labelledBy: "settings-title",
    });
    box.classList.add("modal-box--settings");

    const win = document.createElement("div");
    win.className = "set-win";

    /* --- The rail ------------------------------------------------------- */
    const rail = document.createElement("nav");
    rail.className = "set-rail";
    rail.setAttribute("aria-label", "Settings sections");
    const railHead = document.createElement("div");
    railHead.className = "set-rail-head";
    railHead.id = "settings-title";
    railHead.textContent = "Settings";
    const nav = document.createElement("div");
    nav.className = "set-nav";
    rail.append(railHead, nav);

    /* --- The pane ------------------------------------------------------- */
    const pane = document.createElement("div");
    pane.className = "set-pane";
    const paneHead = document.createElement("div");
    paneHead.className = "set-pane-head";
    const paneTitle = document.createElement("div");
    paneTitle.className = "set-pane-title";
    const paneSub = document.createElement("p");
    paneSub.className = "set-pane-sub";
    paneHead.append(paneTitle, paneSub);
    pane.append(paneHead);

    /* `modal-actions` and not only `set-foot`: the app's button styling — the
       inverted primary fill, the size, `font: inherit` — is written as
       `.modal-actions button` and `.modal-actions .modal-ok`. Without that class the
       one button in this window was the platform's own grey control in Arial with a
       2px outset border, inside a window whose whole subject is how the app looks.
       The class is the styling; `.set-foot` adds this window's padding to it. */
    const foot = document.createElement("div");
    foot.className = "modal-actions set-foot";
    const done = document.createElement("button");
    done.className = "modal-ok";
    done.textContent = "Done";
    done.onclick = finish;
    foot.append(done);

    const bodies = {} as Record<SettingsSection, HTMLElement>;
    const buttons = {} as Record<SettingsSection, HTMLButtonElement>;

    for (const section of SECTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "set-nav-item";
      b.dataset.section = section.id;
      b.append(document.createTextNode(section.label));
      b.onclick = () => show(section.id);
      buttons[section.id] = b;
      nav.append(b);

      const body = document.createElement("div");
      body.className = "set-body";
      body.hidden = true;
      /* Filled once, on the way in, rather than every time the section is shown:
         the sync section subscribes to a live feed, and re-filling it on each visit
         would leave one subscription per visit behind. */
      bodies[section.id] = body;
      pane.append(body);
    }
    win.append(rail, pane, foot);
    box.append(win);

    const filled = new Set<SettingsSection>();
    function show(id: SettingsSection) {
      const section = SECTIONS.find((s) => s.id === id)!;
      paneTitle.textContent = section.title;
      paneSub.textContent = section.blurb;
      for (const s of SECTIONS) {
        bodies[s.id].hidden = s.id !== id;
        if (s.id === id) buttons[s.id].setAttribute("aria-current", "page");
        else buttons[s.id].removeAttribute("aria-current");
      }
      if (!filled.has(id)) {
        filled.add(id);
        const teardown = section.fill(bodies[id], input, finish);
        if (teardown) teardowns.push(teardown);
      }
    }

    show(input.section ?? SECTIONS[0].id);
    buttons[input.section ?? SECTIONS[0].id].focus();
    /* The one thing a section says about itself from outside — see `set-dot`. It
       is read after the window is up, because the window is worth opening whether
       or not the answer arrives. */
    void markConfigState(buttons.config);
  });
}

/** The dot beside "Config repository": grey when it is running, amber when it is
 *  waiting on an answer only a person can give, red when a fault is standing in
 *  the way, and absent when sync is off — an off feature has nothing to report.
 *
 *  Read here rather than passed in, because it is this section's own fact and the
 *  caller would only be relaying it. Silent on failure: a dot that cannot be
 *  coloured says nothing, which is the honest reading of "we could not ask". */
async function markConfigState(btn: HTMLButtonElement): Promise<void> {
  try {
    const summary = await syncSummary();
    if (!summary.on) return;
    const dot = document.createElement("span");
    dot.className = "set-dot";
    if (summary.state.fault) {
      dot.classList.add("set-dot--error");
      dot.title = "Syncing is stopped by a fault";
    } else if ((await syncQuestions()).length > 0) {
      dot.classList.add("set-dot--wait");
      dot.title = "Syncing is waiting on an answer";
    } else {
      dot.title = "Syncing";
    }
    btn.append(dot);
  } catch (e) {
    console.debug("sync state for the settings rail unavailable", e);
  }
}

const SECTIONS: Section[] = [
  {
    id: "appearance",
    label: "Appearance",
    title: "Appearance",
    blurb:
      "Applies as you pick it. The terminal's own type follows, rounded to a whole "
      + "pixel so its character grid stays sharp.",
    fill: (body, input) => {
      body.append(sectionHead("Text size"));
      const group = document.createElement("div");
      group.className = "settings-sizes";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "Text size");
      const buttons: HTMLButtonElement[] = [];
      const select = (scale: number) => {
        applyScale(scale, document.documentElement);
        input.onScale(scale);
        for (const b of buttons) {
          const mine = Number(b.dataset.scale) === scale;
          b.classList.toggle("selected", mine);
          b.setAttribute("aria-checked", String(mine));
        }
      };
      for (const step of SCALE_STEPS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "settings-size";
        b.dataset.scale = String(step);
        b.setAttribute("role", "radio");
        // The label is the name, so no separate `aria-label`: "115% · 14.95px" is
        // what is on the button and what a reader should say.
        b.textContent = scaleLabel(step);
        b.onclick = () => select(step);
        buttons.push(b);
        group.append(b);
      }
      body.append(group);
      const now = currentScale();
      for (const b of buttons) {
        const mine = Number(b.dataset.scale) === now;
        b.classList.toggle("selected", mine);
        b.setAttribute("aria-checked", String(mine));
      }
      const hint = document.createElement("p");
      hint.className = "form-hint";
      hint.textContent = "Hit targets keep their pixel size, so they do not shrink with the text.";
      body.append(hint);
    },
  },
  {
    id: "scenarios",
    label: "Scenarios",
    title: "Scenarios",
    blurb:
      "A scenario is a prompt you keep, and the journal is what one leaves behind. "
      + "This is where you decide whether that record is kept at all.",
    /* The switch was in the journal's own head, where a setting sat above the records
       it governs and read as a third filter in a 280px column. A setting is a thing
       you set once and leave; this window is where those live. The journal keeps the
       SENTENCE — an empty page whose emptiness is a setting has to say so where the
       emptiness is. */
    fill: (body, input) => {
      body.append(sectionHead("The journal"));
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = input.recording;
      box.dataset.fk = "record-runs";
      box.onchange = () => input.onRecording(box.checked);
      body.append(labeledCheck("Record scenario runs", box,
        "Every run a scenario starts is written down: how it started, how long it took "
        + "and what it reported. Sessions you start yourself are never recorded."));
      const hint = document.createElement("p");
      hint.className = "form-hint";
      /* The one thing a person needs to know before switching it off, and the one
         thing they need to know before switching it back on. Both, because this
         control has no undo and no confirmation — it applies as it is touched. */
      hint.textContent = "Switching this off stops new records. Everything already "
        + "written stays where it is and stays readable — nothing is erased.";
      body.append(hint);

      /* The limits block's one setting, and it belongs in this window for the
         same reason the switch above does: it is set once and left. It sits under
         the journal rather than in a section of its own because both answer the
         same shape of question — how much this app is allowed to find out and
         write down about what it runs. */
      body.append(sectionHead("Limits"));
      const rep = document.createElement("input");
      rep.type = "checkbox";
      rep.checked = input.reportedLimits;
      rep.dataset.fk = "reported-limits";
      rep.onchange = () => input.onReportedLimits(rep.checked);
      body.append(labeledCheck("Ask the AI what is left", rep,
        "The account's own figure, which is the only one that counts what other "
        + "terminals and other machines have spent. Asking costs nothing from your "
        + "budget and hands over no password — the app asks the AI's own command, "
        + "the way it asks gh about GitHub."));
      const repHint = document.createElement("p");
      repHint.className = "form-hint";
      /* What switching it off actually costs, and what it does not: the block
         does not disappear, which is the whole design (ADR-0009). */
      repHint.textContent = "Off, the limits block stays where it is and says so: it "
        + "then counts only what this app can see from the sessions it runs, which is "
        + "less than the account has spent. Switching it off also stops the app "
        + "starting a short-lived process every few minutes to ask.";
      body.append(repHint);
    },
  },
  {
    id: "notes",
    label: "Session notes",
    title: "Session notes",
    blurb:
      "A closed session can leave a note behind, which is what later sessions and "
      + "agents search. Writing one costs a model call on your own account.",
    fill: (body, input) => {
      body.append(sectionHead("When a session closes"));
      const group = document.createElement("div");
      group.className = "settings-choice";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "Write a note when a session closes");

      /* Three, because the state genuinely has three values. A checkbox would
         have to draw "never asked" as one of the other two, and whichever it
         picked would be a claim nobody made — the app deciding, in the interface,
         a question about spending somebody's money. */
      const choices: { label: string; value: boolean | undefined }[] = [
        { label: "Ask each time", value: undefined },
        { label: "Always write one", value: true },
        { label: "Never write one", value: false },
      ];
      const buttons: HTMLButtonElement[] = [];
      const paint = (value: boolean | undefined) => {
        for (const b of buttons) {
          const mine = b.dataset.value === String(value);
          b.classList.toggle("selected", mine);
          b.setAttribute("aria-checked", String(mine));
        }
      };
      for (const choice of choices) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "settings-size";
        b.dataset.value = String(choice.value);
        b.dataset.fk = `capture-${choice.value}`;
        b.setAttribute("role", "radio");
        b.textContent = choice.label;
        b.onclick = () => {
          input.onCaptureOnClose(choice.value);
          paint(choice.value);
        };
        buttons.push(b);
        group.append(b);
      }
      paint(input.captureOnClose);
      body.append(group);

      const hint = document.createElement("p");
      hint.className = "form-hint";
      hint.textContent =
        "The session's transcript is sent to a model to be summarised, on your own "
        + "Claude account — so it spends from your plan or your API budget. The note "
        + "is saved on this machine. Sessions with nothing in them are skipped, and "
        + "cost nothing.";
      body.append(hint);

      /* The rooms, in this section rather than one of their own: a diary room is
         what a session note's lessons are filed into, so it is the same subject
         and a second rail row would split it. Mounted, like the sync section, so
         the window stays a rail and a pane. */
      body.append(sectionHead("Diary rooms"));
      const rooms = document.createElement("div");
      body.append(rooms);
      const live = mountRooms(rooms);
      const roomsHint = document.createElement("p");
      roomsHint.className = "form-hint";
      roomsHint.textContent =
        "Lessons worth carrying to other projects are filed into a room, chosen by the "
        + "model from the sentence you write here. Rooms are global — that is what lets "
        + "a mistake made in one repository stop the same mistake in the next. A lesson "
        + "that fits no room is not filed.";
      body.append(roomsHint);
      return () => live.dispose();
    },
  },
  {
    id: "config",
    label: "Config repository",
    title: "Config repository",
    blurb:
      "Your workspaces, scenarios and the memory of past sessions, kept in a private "
      + "GitHub repository so a second machine has them too.",
    /* The same renderer the first-run offer opens, not a second copy of it: there
       is one set of facts here and five states of them, and a second rendering
       would drift on the third state nobody remembered to update. */
    fill: (body) => {
      const live = mountSync(body);
      return () => live.dispose();
    },
  },
  {
    id: "files",
    label: "Files",
    title: "Files",
    blurb:
      "Where this app keeps what it knows — and what the workspace you are on is "
      + "bound to. Two owners, said apart.",
    fill: (body, input, close) => {
      if (input.paths) {
        const p = input.paths;
        body.append(sectionHead("The app's own files"));
        body.append(kv("Directory", p.dir, {
          mono: true,
          action: { label: "Reveal", run: () => input.onReveal(p.dir) },
        }));
        const names = document.createElement("p");
        names.className = "set-files";
        /* Every one of them named, including the ones not written yet, and the
           absent ones say so: a person looking for a file they have never saved
           needs to be told it is not there rather than shown a shorter list. */
        for (const f of p.files) {
          const chip = document.createElement("span");
          chip.className = "set-file" + (f.exists ? "" : " set-file--absent");
          chip.textContent = f.name;
          if (!f.exists) chip.title = "Not written yet";
          names.append(chip);
        }
        body.append(names);
      }

      const ws = input.workspace;
      if (!ws) {
        const none = document.createElement("p");
        none.className = "form-hint";
        none.textContent = "No workspace is active, so there is nothing bound to show.";
        body.append(none);
        return;
      }
      /* A second owner, said apart. Conflating the two is how "where is my config"
         gets answered with a path that turns out to be one project's. */
      body.append(sectionHead(`This workspace · ${ws.name}`));
      body.append(kv("Folder", ws.path, {
        mono: true,
        action: { label: "Reveal", run: () => input.onReveal(ws.path) },
      }));
      /* The account is the fact this window exists to surface: "which account does
         a push from here go out as" was answerable only by opening the form that
         changes it. */
      body.append(kv(
        "Pushes as",
        ws.github?.login ? `${ws.github.login} · ${ws.github.host}` : "no account bound",
        { muted: !ws.github?.login },
      ));
      body.append(kv("Tasks come from", input.taskSource ?? "nothing configured", {
        muted: input.taskSource === null,
        /* Handing over closes this window: the workspace form owns these fields,
           and two modals about one workspace is a stack nobody asked for. */
        action: { label: "Edit workspace…", run: () => { close(); input.onEditWorkspace(); } },
      }));
    },
  },
];

/** A group's heading inside a pane. Not an `h2`: the window's accessible name is
 *  its title and these are groups within one document rather than documents of
 *  their own, so a heading level here would claim an outline the modal has not
 *  got. */
function sectionHead(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "set-head";
  h.textContent = text;
  return h;
}

/** One fact: what it is, what it is, and — where there is one — the thing to press
 *  about it. A definition row rather than a form row, because none of these is a
 *  field: they are read-only answers, and the one control opens the form that owns
 *  what it changes. */
function kv(
  label: string,
  value: string,
  opts: { mono?: boolean; muted?: boolean; action?: { label: string; run: () => void } } = {},
): HTMLElement {
  const row = document.createElement("div");
  row.className = "set-kv";
  const l = document.createElement("span");
  l.className = "set-kv-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "set-kv-value"
    + (opts.mono ? " set-kv-value--mono" : "")
    + (opts.muted ? " set-kv-value--muted" : "");
  v.textContent = value;
  v.title = value;
  row.append(l, v);
  if (opts.action) {
    const b = document.createElement("button");
    b.className = "set-kv-act";
    b.textContent = opts.action.label;
    b.onclick = opts.action.run;
    row.append(b);
  }
  return row;
}
