# The status-area icon and the dock badge — manual check

Nothing below is covered by automated tests, and most of it cannot be. The
composition of the menu is pure and unit-tested (`tests/tray-panel.test.ts`), and
so are the two rules the Rust half holds (`src-tauri/src/tray.rs`); what is left
is everything the desktop does with them, and no suite can open a menu bar. The
design behind it is ADR-0011.

Work through the list for the platform you are on and record the result in the
pull request description. **The three platform sections are not
interchangeable** — a tray icon is the one feature where each desktop does
something different with the same call.

## Everywhere

- [ ] The icon appears in the status area within a second or two of launch, before any session is started.
- [ ] Quit the app and launch it again. The icon comes back.
- [ ] Open the menu with no sessions and no AI on the machine. It reads **Limits / No AI detected on this machine** and **Sessions / No sessions are open**, then **Open cowork-deck** and **Quit cowork-deck**.
- [ ] Every limit row carries a tier word — Reported, Observed, Estimated or Unknown — beside its number. A row with a bare percentage is a bug, not a nicety (ADR-0009).
- [ ] The reading in a menu row matches the same provider's row in the deck's Limits block, word for word.
- [ ] Start a session and let it ask for permission. Its name appears under **Sessions** with "waiting for input", and clicking it raises the deck and focuses that tile.
- [ ] Pull a workspace out into its own window and let one of its sessions wait. Clicking the row raises **that** window, not the main one — the deck must not flash forward first.
- [ ] Click a limit row. The usage dialog opens in the deck, on the provider you clicked.
- [ ] **Open cowork-deck** raises the deck from minimised and from hidden.
- [ ] **Quit cowork-deck** with a session running asks the same question Cmd+Q asks, rather than killing it. Cancel, and the app is still there with its icon.
- [ ] Leave the app open and idle for a few minutes with the menu **open**. It should not flicker or close under the cursor: an unchanged report is dropped rather than rebuilt.
- [ ] Hover the icon. The tooltip says `cowork-deck`, or names what is waiting or what has run out. It never carries a bare count — that is the pill's sentence.

## macOS

The template image is the thing to look at, and both appearances have to be
checked: a non-template icon looks correct on exactly one of them.

- [ ] Light menu bar (System Settings → Appearance → Light): the mark is **dark** and legible.
- [ ] Dark menu bar (Appearance → Dark): the same mark is **light** and legible.
- [ ] "Auto" with the wallpaper changing under the menu bar: it follows.
- [ ] Click the icon. While the menu is open the icon **inverts** along with the highlighted status item. If it stays dark on a blue highlight, the image is not being treated as a template.
- [ ] The mark is not blurry. It is drawn at 18 points from a 36-pixel image; a soft edge means something resampled it.
- [ ] Left click and right click both open the menu. That is the platform's convention for a status item.
- [ ] With the deck **not** in front and a session waiting, the dock icon carries a number, and the number is the count of waiting sessions.
- [ ] Click the deck in the dock. The badge goes as it comes forward.
- [ ] While the deck is in front, let another session start waiting. **No badge appears.** This is the rule, not the event: a report arriving while you are looking must not put one back.
- [ ] Click away to another app. The badge comes back with the right number.
- [ ] Answer every waiting session. The badge goes.
- [ ] Quit with sessions waiting. No badge is left on a dock icon of an app that is not running.

## Windows

- [ ] The icon is in the notification area. If Windows has hidden it in the overflow, dragging it out is the person's business, not a bug.
- [ ] **Right** click opens the menu.
- [ ] **Left** click raises the deck rather than opening the menu.
- [ ] With the deck not in front and a session waiting, the taskbar button carries the amber overlay dot. There is no number, and there is not meant to be — 16×16 has no room for one.
- [ ] Focus the deck. The overlay goes.
- [ ] The dot is legible against both a light and a dark taskbar.

## Linux

Expect this section to be partly "not on this desktop", and record which desktop
you were on. That is the honest result, not a failure.

- [ ] The icon is in the top panel. On GNOME this needs an AppIndicator extension; without one, no icon appears, and that is the desktop's decision rather than the app's.
- [ ] The menu opens. It is the only interaction that is guaranteed — nothing in the design depends on a left click being delivered.
- [ ] Installed from the `.deb`, `libayatana-appindicator3-1` is pulled in as a dependency rather than being something you had to install by hand.
- [ ] On a desktop with the Unity launcher API (Ubuntu's dock): the launcher icon carries the count, and it clears on focus and on quit.
- [ ] On a desktop without it: no badge, and nothing breaks. Best-effort is the whole promise here.

## The pill, which must not have become a duplicate

- [ ] With a session waiting and the deck not in front: the pill says "N waiting for input" and the tray icon says nothing at all — no count, no title, no changed image.
- [ ] With the budget spent: the pill says so, and the icon is still unchanged. The menu is where the tray says it, in words and with the tier.
- [ ] With the deck idle and nothing waiting: the pill is down and the icon is still there. That is the tray's own reason to exist.
