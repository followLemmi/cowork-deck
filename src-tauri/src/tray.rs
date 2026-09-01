//! The status-area presence, and the dock badge.
//!
//! An icon in the menu bar on macOS, the top panel on Linux and the notification
//! area on Windows, with a menu behind it — plus the count on the dock icon. Two
//! halves of one problem: the app has things to say while its window is not in
//! front, and until now the floating pill was the only thing that could say them.
//!
//! **This file knows nothing about limits or sessions.** It turns a list of
//! sections into a menu, routes a click back, and tells the dock a number. What
//! goes in the rows is composed in `src/tray-panel.ts`, out of the same pure
//! helpers the limits block and the usage dialog draw from, and arrives here
//! through `tray_update`. That split is the decision — the reason for it, and
//! the reason the panel is a native menu rather than a second webview window, is
//! ADR-0011.
//!
//! The one rule to keep while editing: nothing below may grow a provider's name,
//! a window's name, a reading or a reset time. The moment it does, there are two
//! implementations of a formatting rule and they begin to drift.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::windows;

/// The tray icon's id. One icon, for the life of the app.
pub const TRAY_ID: &str = "deck";

/// The fixed rows at the foot of the menu, which the deck does not compose.
const OPEN_ID: &str = "tray:open";
const QUIT_ID: &str = "tray:quit";

/// What a clickable row's id begins with. Everything after it is the row's
/// action, verbatim, and it is the only thing sent back to the deck.
const ACTION_PREFIX: &str = "tray:do:";

/* --- The model the deck sends -------------------------------------------- */

/// One row.
///
/// `action` is what separates a control from a reading. A row with none is
/// drawn disabled — it is a fact, and a fact that can be clicked invites a
/// click that does nothing.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct TrayRow {
    pub text: String,
    #[serde(default)]
    pub action: Option<String>,
}

/// One section: a heading and its rows.
///
/// A section always has a heading, and its rows are never empty — a section with
/// nothing to report says so in a row of its own, because a heading over a blank
/// is worse than a sentence. That is the deck's rule to keep, not this file's;
/// see `src/tray-panel.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct TraySection {
    pub heading: String,
    pub rows: Vec<TrayRow>,
}

/// The whole panel, as one report.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct TrayPanel {
    pub sections: Vec<TraySection>,
    /// What the icon says on hover. One line, and never a count — see ADR-0011
    /// decision 3 on why the pill keeps that job.
    pub tooltip: String,
    /// Sessions waiting for input, for the dock badge.
    pub waiting: i64,
}

/// What a click on a row is reported as.
#[derive(Debug, Clone, Serialize)]
struct TrayAction {
    action: String,
}

/* --- Ids ------------------------------------------------------------------ */

/// The action a menu id names, or `None` when the id is not a row of ours.
///
/// Separate from the handler and tested on its own, because it is the join
/// between two files in two languages: `src/tray-panel.ts` mints the action and
/// `src/app.ts` reads it back, and neither can see this string.
fn action_of(id: &str) -> Option<&str> {
    id.strip_prefix(ACTION_PREFIX).filter(|a| !a.is_empty())
}

/// The id a clickable row gets.
fn id_for(action: &str) -> String {
    format!("{ACTION_PREFIX}{action}")
}

/* --- The menu ------------------------------------------------------------- */

/// Build the menu for a panel.
///
/// The layout, and the whole of it: a separator between sections, a disabled
/// heading, then the rows, then the two fixed items. **Adding a section to the
/// panel does not come through here** — this function has never heard of one.
///
/// Ids are unique by construction: a clickable row's is its action, and every
/// disabled item gets a counter. Duplicates would not misfire, since a disabled
/// item cannot be clicked, but an ambiguous id is not a thing to leave lying
/// around in a routing table.
fn build_menu<R: Runtime>(app: &AppHandle<R>, panel: &TrayPanel) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    let mut inert = 0usize;
    let mut disabled = |text: &str| -> tauri::Result<MenuItem<R>> {
        inert += 1;
        MenuItem::with_id(app, format!("tray:inert:{inert}"), text, false, None::<&str>)
    };

    // Counted rather than asked. `Menu::items` is a round trip to the main
    // thread, and this loop would make one per section to learn something it
    // already knows.
    let mut written = false;
    for section in &panel.sections {
        if written {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        written = true;
        menu.append(&disabled(&section.heading)?)?;
        for row in &section.rows {
            match &row.action {
                Some(action) => menu.append(&MenuItem::with_id(
                    app,
                    id_for(action),
                    &row.text,
                    true,
                    None::<&str>,
                )?)?,
                None => menu.append(&disabled(&row.text)?)?,
            }
        }
    }

    if written {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, OPEN_ID, "Open cowork-deck", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, QUIT_ID, "Quit cowork-deck", true, None::<&str>)?)?;
    Ok(menu)
}

/// Bring the deck forward. The same three calls, in the same order, as
/// `raiseThisWindow` in `src/app.ts` and the notification click handler.
fn raise_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window(windows::MAIN) else { return };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// A menu item was chosen.
///
/// Only the two fixed items are acted on here. A row belongs to the deck — it is
/// the deck that knows which window holds a session and which provider a row is
/// about — so a row's action is forwarded and nothing is raised: raising the
/// main window before the deck routed the click to a workspace window would
/// flash the wrong window forward, which is the mistake `pill://focus-next`
/// already avoids by letting the far end raise itself.
fn on_menu<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        OPEN_ID => raise_main(app),
        // Through `exit` rather than a predefined Quit item, so the gesture
        // arrives at `RunEvent::ExitRequested` and passes `ready_to_quit` like
        // every other way out of this app. A quit that skipped it would kill
        // live sessions without asking.
        QUIT_ID => app.exit(0),
        id => {
            let Some(action) = action_of(id) else { return };
            let _ = app.emit_to(
                windows::MAIN,
                "tray://action",
                TrayAction { action: action.to_string() },
            );
        }
    }
}

/// The icon itself was clicked.
///
/// Windows only, and by convention rather than by necessity: there, right-click
/// opens the menu and left-click is expected to show the window, so the menu is
/// built with `show_menu_on_left_click(false)` and this supplies the other half.
/// macOS opens the menu on either button, which is that platform's convention
/// for a status item. Linux delivers neither reliably — on most desktops an
/// indicator's left click never reaches the application — which is why nothing
/// in this design depends on the distinction.
fn on_icon<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    #[cfg(target_os = "windows")]
    if matches!(
        event,
        TrayIconEvent::Click {
            button: tauri::tray::MouseButton::Left,
            button_state: tauri::tray::MouseButtonState::Up,
            ..
        }
    ) {
        raise_main(tray.app_handle());
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (tray, event);
}

/// The image the status area shows.
///
/// On macOS a template image, which is monochrome by construction: the system
/// reads its alpha channel alone and tints the result for a light menu bar, a
/// dark one, and the inverted state while the menu is open. Elsewhere the app's
/// own colour icon, which is what those platforms expect — a Windows
/// notification area and a Linux panel tint nothing.
fn icon<R: Runtime>(app: &AppHandle<R>) -> Option<Image<'static>> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        match Image::from_bytes(include_bytes!("../icons/tray-mac.png")) {
            Ok(img) => Some(img.to_owned()),
            Err(e) => {
                eprintln!("error: the menu bar icon could not be decoded ({e})");
                None
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // `.to_owned()` and not only `.cloned()`: the handle's copy borrows the
        // bytes the app was built with, and the tray outlives this call.
        app.default_window_icon().cloned().map(|i| i.to_owned())
    }
}

/// Put the icon up. Once, during setup.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(TrayState::default());

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        // Never a count, and never a title — the pill owns the glance. ADR-0011.
        .tooltip("cowork-deck")
        .menu(&build_menu(app, &TrayPanel::default())?)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_icon);
    let builder = match icon(app) {
        Some(img) => builder.icon(img),
        None => builder,
    };
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true).show_menu_on_left_click(true);
    #[cfg(target_os = "windows")]
    let builder = builder.show_menu_on_left_click(false);

    builder.build(app)?;
    Ok(())
}

/* --- What the deck has told us -------------------------------------------- */

/// The last report, and whether the dock is allowed to speak.
///
/// Managed separately from `AppState` because none of it is the deck's state:
/// it is what this surface last drew, kept so that an unchanged report can be
/// dropped rather than rebuilt.
#[derive(Default)]
pub struct TrayState {
    panel: Mutex<TrayPanel>,
    /// Sessions waiting, as last reported. Held apart from `panel` because the
    /// badge is also cleared by focus and by quit, neither of which is a report.
    waiting: AtomicI64,
    /// Whether the deck is in front. A badge is a way of telling somebody who is
    /// not looking; while they are, it has nothing to say.
    focused: AtomicBool,
}

/// What the dock should show. `None` is no badge at all.
///
/// Pure, and tested as a rule: "clears on focus" is not an event that arrives
/// once — a report landing while the window is in front must not put the badge
/// back, which is the whole difference between a badge and a stale badge.
pub fn badge_count(waiting: i64, focused: bool) -> Option<i64> {
    if focused || waiting <= 0 {
        None
    } else {
        Some(waiting)
    }
}

/// Write the badge the current state calls for.
fn apply_badge<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<TrayState>() else { return };
    let count = badge_count(
        state.waiting.load(Ordering::SeqCst),
        state.focused.load(Ordering::SeqCst),
    );
    let Some(win) = app.get_webview_window(windows::MAIN) else { return };
    // Unsupported on Windows and best-effort on Linux, where it needs a desktop
    // with the Unity launcher API. Silent on failure for that reason: a badge
    // the desktop does not do is not a fault to report on every tick.
    let _ = win.set_badge_count(count);
    #[cfg(target_os = "windows")]
    {
        // 16x16 over the taskbar button is no room for a number, so this
        // degrades to a state: something is waiting, or nothing is.
        let overlay = match count {
            Some(_) => Image::from_bytes(include_bytes!("../icons/badge-win.png")).ok(),
            None => None,
        };
        let _ = win.set_overlay_icon(overlay);
    }
}

/// The deck's report: what the menu says, and how many sessions are waiting.
///
/// An identical report is dropped. The deck reports on every poll tick, five
/// seconds apart, and rebuilding a native menu that often would rebuild it under
/// an open cursor.
#[tauri::command]
pub fn tray_update(app: AppHandle, panel: TrayPanel) {
    let Some(state) = app.try_state::<TrayState>() else { return };
    state.waiting.store(panel.waiting, Ordering::SeqCst);
    apply_badge(&app);

    {
        let mut last = state.panel.lock().expect("tray panel");
        if *last == panel {
            return;
        }
        *last = panel.clone();
    }

    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    match build_menu(&app, &panel) {
        // Silent on success and loud on failure, because a menu that stopped
        // updating looks exactly like a deck with nothing to report.
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                eprintln!("error: the tray menu could not be replaced ({e})");
            }
            if let Err(e) = tray.set_tooltip(Some(&panel.tooltip)) {
                eprintln!("error: the tray tooltip could not be set ({e})");
            }
        }
        Err(e) => eprintln!("error: the tray menu could not be built ({e})"),
    }
}

/// The deck came forward, or went away. Clears the badge and puts it back.
pub fn set_focused<R: Runtime>(app: &AppHandle<R>, focused: bool) {
    let Some(state) = app.try_state::<TrayState>() else { return };
    state.focused.store(focused, Ordering::SeqCst);
    apply_badge(app);
}

/// The app is going. Takes the badge down first.
///
/// On macOS the dock tile goes with the process, so this is for Linux, where a
/// launcher told a count over D-Bus keeps showing it — a number left behind by an
/// application that is no longer running is the worst version of a stale badge.
pub fn clear_badge<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<TrayState>() else { return };
    state.waiting.store(0, Ordering::SeqCst);
    apply_badge(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_action_id_round_trips() {
        assert_eq!(action_of(&id_for("usage:claude")), Some("usage:claude"));
        assert_eq!(action_of(&id_for("session:01J")), Some("session:01J"));
    }

    #[test]
    fn the_fixed_items_are_not_actions() {
        assert_eq!(action_of(OPEN_ID), None);
        assert_eq!(action_of(QUIT_ID), None);
        assert_eq!(action_of("tray:inert:3"), None);
    }

    /// An empty action would forward an empty string to the deck, which has
    /// nothing to route it to. It is not a row anybody can mint through
    /// `id_for`, and it is refused anyway.
    #[test]
    fn an_empty_action_is_not_one() {
        assert_eq!(action_of(ACTION_PREFIX), None);
    }

    #[test]
    fn the_badge_counts_what_is_waiting() {
        assert_eq!(badge_count(3, false), Some(3));
    }

    /// The rule, not the event: a report landing while the deck is in front must
    /// not put the badge back.
    #[test]
    fn a_focused_deck_shows_no_badge() {
        assert_eq!(badge_count(3, true), None);
    }

    #[test]
    fn an_empty_queue_shows_no_badge() {
        assert_eq!(badge_count(0, false), None);
        // Not reachable from `sumWaiting`, and a negative count would be drawn
        // as a badge by `Some(-1)` rather than refused.
        assert_eq!(badge_count(-1, false), None);
    }
}
