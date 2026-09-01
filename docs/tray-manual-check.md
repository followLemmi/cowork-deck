# The status-area panel and the dock badge — manual check

Nothing below is covered by automated tests, and most of it cannot be. What the
panel says is pure and unit-tested (`tests/tray-panel.test.ts`), and so are the
rules the Rust half holds — where the panel lands, when the badge shows, and the
re-open guard (`src-tauri/src/tray.rs`). What is left is everything the desktop
does with them, and no suite can open a window positioned under a status icon.
The design behind it is ADR-0011.

Work through the list for the platform you are on and record the result in the
pull request description. **The three platform sections are not
interchangeable** — this is the one feature where each desktop does something
different with the same call, and Linux gets a different surface entirely.

## Everywhere

- [ ] The icon appears in the status area within a second or two of launch, before any session is started.
- [ ] It is recognisably this app: the rounded frame with the chevron and the cursor block inside it. Put the dock beside the status area — the same mark, simplified.
- [ ] It is not a black smudge and not a blank space. Either means the art and the `icon_as_template` flag have come apart again — they are returned as a pair by `icon()` precisely so they cannot; see ADR-0011 decision 5.
- [ ] Quit the app and launch it again. The icon comes back.
- [ ] Every limit row carries a tier word — Reported, Observed, Estimated or Unknown — beside its number. A row with a bare percentage is a bug, not a nicety (ADR-0009).
- [ ] The reading and the meter in the panel match the same provider's row in the deck's own Limits block, word for word and fill for fill. They are the same component; if they differ, something has been reimplemented.
- [ ] Start a session and let it ask for permission. It appears at the top of **Sessions** with an amber rail and "waiting for input", and clicking it raises the deck and focuses that tile.
- [ ] Pull a workspace out into its own window and let one of its sessions wait. Clicking the row raises **that** window, not the main one — the deck must not flash forward first.
- [ ] A session that has stopped on an error is red, and says so in words as well as in colour.
- [ ] Sessions are ordered by what wants a person: waiting, then error, then finished-a-turn, then working, then idle, then ended.
- [ ] Click a limit row. The usage dialog opens in the deck, on the provider you clicked.
- [ ] With no AI on the machine, or none readable: the section says so under its heading rather than showing a gap.
- [ ] On an unreadable row, "Ask" opens the probe command in a tile in the deck.
- [ ] **Open the deck** raises the deck from minimised and from hidden, and the panel goes as it does.
- [ ] **Quit** with a session running asks the same question Cmd+Q asks, rather than killing it. Cancel, and the app is still there with its icon.
- [ ] Hover the icon. The tooltip says `cowork-deck`, or names what is waiting or what has run out. It never carries a bare count — that is the pill's sentence.

## macOS

The icon here is a **template image** (`icons/tray-template.png`): monochrome art
that the system tints. Everything below is checking that the system is in fact
tinting it, which is what makes it one of the row rather than a picture stuck in
it. `node scripts/tray-icon.mjs` regenerates the art.

- [ ] Dark menu bar (System Settings → Appearance → Dark): the mark is **white**, the same white as Wi-Fi, the battery and the clock beside it.
- [ ] Light menu bar (Appearance → Light): the same mark is **black**. If it is white on both, or black on both, the flag is not reaching the image.
- [ ] Open the panel. While it is open the icon **inverts** with the highlighted status item. If it stays dark on a blue highlight, it is not being treated as a template.
- [ ] A light wallpaper behind a translucent menu bar, and a dark one. Both.
- [ ] The frame is a visible outline at 18 points, not a smudge, and the chevron inside it is readable.
- [ ] The mark is not blurry. It is drawn at 18 points from a 36-pixel image, so at 2× it is 1:1; a soft edge means something resampled it.
- [ ] Left click and right click both open the panel. That is the platform's convention for a status item.

### The panel as a window

- [ ] It opens **centred under the icon**, with a visible gap below the menu bar.
- [ ] Its own shadow is under its rounded corners. There is no second rounded rectangle floating around it — that is the window's shadow, and it is turned off.
- [ ] Click the icon again. It closes. It does **not** flicker closed and open again — that is what `REOPEN_GUARD` prevents, and it is the easiest thing here to break.
- [ ] Click anywhere outside it. It closes.
- [ ] Press Escape while it is open. It closes.
- [ ] Click inside it, on something that is not a control. It stays open.
- [ ] With the deck on a second display and the menu bar on another, open the panel from each. It appears on the display whose menu bar you clicked.
- [ ] Move the icon (⌘-drag it along the menu bar) and open it again. It follows.
- [ ] Open it with one AI and no sessions, then with a dozen sessions. The panel grows to fit and does not leave a tall empty rectangle.
- [ ] With more sessions than fit: the panel stops growing, the list scrolls inside it, and the footer stays put.
- [ ] Change the text size in Settings. The panel follows on its next update.

### The dock badge

- [ ] With the deck **not** in front and a session waiting, the dock icon carries a number, and the number is the count of waiting sessions.
- [ ] Click the deck in the dock. The badge goes as it comes forward.
- [ ] While the deck is in front, let another session start waiting. **No badge appears.** This is the rule, not the event: a report arriving while you are looking must not put one back.
- [ ] Click away to another app. The badge comes back with the right number.
- [ ] Answer every waiting session. The badge goes.
- [ ] Quit with sessions waiting. No badge is left on a dock icon of an app that is not running.

## Windows

- [ ] The icon is in the notification area, in **colour** (`icons/tray-colour.png`) — Windows tints nothing, and colour is the convention there. If it is a monochrome glyph, the macOS art is being used.
- [ ] It reads against both a light and a dark taskbar. The frame's lit hairline is what carries the dark case.
- [ ] If Windows has hidden it in the overflow, dragging it out is the person's business, not a bug.
- [ ] **Right** click opens the panel.
- [ ] **Left** click raises the deck rather than opening the panel.
- [ ] The panel opens **above** the icon, not below it — the notification area is at the foot of the screen, and there is no room under it.
- [ ] It grows **upwards** as its content grows, and stays above the taskbar.
- [ ] With the deck not in front and a session waiting, the taskbar button carries the amber overlay dot. There is no number, and there is not meant to be — 16×16 has no room for one.
- [ ] Focus the deck. The overlay goes.
- [ ] The dot is legible against both a light and a dark taskbar.

## Linux

**Linux gets a native menu, not the panel**, and that is the design rather than a
shortfall: an indicator's click is not deliverable to the application on most
desktops, so a panel opened on a click would never open. Expect part of this
section to be "not on this desktop", and record which desktop you were on. That
is the honest result, not a failure.

- [ ] The icon is in the top panel, in **colour** — like Windows, nothing here tints. On GNOME this needs an AppIndicator extension; without one, no icon appears, and that is the desktop's decision rather than the app's.
- [ ] The **menu** opens, with the same sections and the same headings the panel has on the other platforms — Limits, then Sessions, then Open and Quit.
- [ ] Every limit row in it carries its tier. The menu has no meter, by necessity; it must not have lost the word beside the number.
- [ ] A waiting session's row raises the window that holds it.
- [ ] Nothing anywhere tries to open a window under the icon.
- [ ] Installed from the `.deb`, `libayatana-appindicator3-1` is pulled in as a dependency rather than being something you had to install by hand.
- [ ] On a desktop with the Unity launcher API (Ubuntu's dock): the launcher icon carries the count, and it clears on focus and on quit.
- [ ] On a desktop without it: no badge, and nothing breaks. Best-effort is the whole promise here.

## The pill, which must not have become a duplicate

- [ ] With a session waiting and the deck not in front: the pill says "N waiting for input" and the tray icon says nothing at all — no count, no title, no changed image.
- [ ] With the budget spent: the pill says so, and the icon is still unchanged. The panel is where the tray says it, with the tier beside it. The icon never signals state — a mark is a reading with no tier beside it (ADR-0009).
- [ ] With the deck idle and nothing waiting: the pill is down and the icon is still there. That is the tray's own reason to exist.
