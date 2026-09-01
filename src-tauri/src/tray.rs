//! The status-area presence, and the dock badge.
//!
//! An icon in the menu bar on macOS, the top panel on Linux and the notification
//! area on Windows — plus the count on the dock icon. Two halves of one problem:
//! the app has things to say while its window is not in front, and until now the
//! floating pill was the only thing that could say them.
//!
//! **The panel behind the icon is a webview window** (`windows::TRAY`), so it
//! draws the deck's own meters and rows rather than a list of sentences. On
//! Linux it is a native menu instead, because a StatusNotifierItem's click is
//! not deliverable to us on most desktops and a menu is all the platform
//! guarantees. Both are fed the same report and rendered from the same section
//! list; ADR-0011 is the decision and the reasoning.
//!
//! **This file knows nothing about limits or sessions.** It positions a window,
//! turns a list of sections into a menu, routes a click back, and tells the dock
//! a number. What goes in the panel is composed in `src/tray-panel.ts`, out of
//! the same helpers the limits block and the usage dialog draw from.
//!
//! The one rule to keep while editing: nothing below may grow a provider's name,
//! a window's name, a reading or a reset time. The moment it does, there are two
//! implementations of a formatting rule and they begin to drift.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect, Runtime};

use crate::windows;

/// The tray icon's id. One icon, for the life of the app.
pub const TRAY_ID: &str = "deck";

/// The panel's width, in logical pixels. Its height follows its content — see
/// `tray_resize`.
const PANEL_WIDTH: f64 = 340.0;
/// What the panel opens at, before the page has measured itself. Small enough
/// that the first frame is never a tall empty rectangle.
const PANEL_HEIGHT: f64 = 220.0;
/// Never taller than this, whatever the content. Past it the panel scrolls
/// inside itself: a status panel as tall as the screen is a window, and a window
/// is the thing this exists to avoid opening.
const PANEL_MAX_HEIGHT: f64 = 560.0;
/// Between the icon and the panel, and between the panel and the screen edge,
/// in LOGICAL pixels. `place` works in physical ones — the icon's rect and a
/// monitor's work area both arrive that way — so it is scaled on the way in.
/// Six physical pixels on a Retina display is three points, which is not a gap.
const PANEL_GAP: f64 = 6.0;

/// How long after the panel hides a click on the icon is ignored.
///
/// Clicking the icon while the panel is open loses the panel its focus first, so
/// it hides — and then the click arrives and would open it again. The gesture a
/// person made was "close it". Every popover has this problem and every one of
/// them solves it with a short deadline.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

/* --- The model the deck sends -------------------------------------------- */

/// One row.
///
/// `action` is what separates a control from a reading. A row with none is
/// drawn disabled — it is a fact, and a fact that can be clicked invites a
/// click that does nothing.
///
/// Only the Linux menu reads these; the webview panel draws from the facts
/// themselves, because a meter is not a string. They are composed by the same
/// section list, so the two surfaces cannot come to say different things.
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

/// What a click on a row is reported as. The menu's half of the routing — the
/// panel window emits `tray://action` for itself, in the webview.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Serialize)]
struct TrayAction {
    action: String,
}

/* --- The panel window ----------------------------------------------------- */

/// Build it, hidden.
///
/// Created once at startup rather than on the first click, and the reason is the
/// one `WindowReady` documents: a webview that has not run its script yet is
/// listening for nothing, so a panel created on demand would open empty and fill
/// in a frame or two later. Opening it is then a `show`, which is instant.
///
/// Not `always_on_top` by accident: it has to survive being over a full-screen
/// app, and it has to go away when it loses focus, which is why — unlike the
/// pill — it is focusable.
fn build_panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, windows::TRAY, tauri::WebviewUrl::App("tray.html".into()))
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(true)
        .visible(false)
        // macOS draws a window's shadow around the WINDOW, and this window is
        // deliberately larger than the panel drawn in it — `tray.css` insets the
        // shell so its own shadow is not clipped by the window's edge. The
        // platform shadow therefore traced a rounded rectangle in mid air
        // around the panel, which is what this turns off. The shadow that is
        // wanted is the one in the stylesheet, under the panel's own corners.
        .shadow(false)
        // The one window in this app that WANTS the keyboard, and only because
        // losing it is how it knows to go away. The pill is `focusable(false)`
        // for the opposite reason — it is a readout and must never take a
        // keystroke from the session being typed into.
        .focusable(true)
        .build()?;
    Ok(())
}

fn panel<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window(windows::TRAY)
}

/// Where the panel goes for an icon at `icon`, on a screen whose usable area is
/// `work` (both physical, origin at the top-left of the virtual desktop).
///
/// Centred under the icon, pushed back inside the screen if that would hang it
/// off an edge, and flipped above the icon when there is no room below — which
/// is the ordinary case on Windows, where the notification area is at the
/// bottom.
///
/// Pure, and separated from the window for that reason: this is four rules about
/// arithmetic and none of them can be tested through a window that has to be on
/// screen to have a position at all.
pub fn place(
    icon: (i32, i32, u32, u32),
    size: (u32, u32),
    work: (i32, i32, u32, u32),
    gap: i32,
) -> (i32, i32) {
    let (ix, iy, iw, ih) = icon;
    let (pw, ph) = (size.0 as i32, size.1 as i32);
    let (wx, wy, ww, wh) = (work.0, work.1, work.2 as i32, work.3 as i32);

    let mut x = ix + iw as i32 / 2 - pw / 2;
    // `max` last, so that a panel wider than the screen lands on the left edge
    // rather than off the right one. Not reachable today at 340 logical pixels,
    // and the cheaper of the two ways to be wrong about it.
    x = x.min(wx + ww - pw - gap).max(wx + gap);

    let below = iy + ih as i32 + gap;
    let y = if below + ph <= wy + wh {
        below
    } else {
        // Above the icon. Clamped to the top of the work area for the same
        // reason as `x`: a panel taller than the gap above the icon is better
        // truncated at the edge than drawn off it.
        (iy - ph - gap).max(wy + gap)
    };
    (x, y)
}

/// Put the panel where `anchor` says, and remember the anchor so a later resize
/// can put it back.
fn move_panel<R: Runtime>(app: &AppHandle<R>, anchor: Rect) {
    let Some(win) = panel(app) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = anchor.position.to_physical::<i32>(scale);
    let dim = anchor.size.to_physical::<u32>(scale);
    let size = match win.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    // The monitor the ICON is on, not the one the panel was last on: with two
    // displays the panel has to open on the screen whose menu bar was clicked.
    let work = match app.monitor_from_point(pos.x as f64, pos.y as f64) {
        Ok(Some(m)) => {
            let a = m.work_area();
            (a.position.x, a.position.y, a.size.width, a.size.height)
        }
        // No monitor is not a reason to refuse to draw. Somewhere on screen
        // beats nowhere, and the icon's own position is somewhere on screen.
        _ => (pos.x, pos.y, size.width, size.height),
    };
    let (x, y) = place(
        (pos.x, pos.y, dim.width, dim.height),
        (size.width, size.height),
        work,
        (PANEL_GAP * scale).round() as i32,
    );
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Show it under the icon, or hide it if it is already up.
fn toggle_panel<R: Runtime>(app: &AppHandle<R>, anchor: Rect) {
    let Some(win) = panel(app) else { return };
    let Some(state) = app.try_state::<TrayState>() else { return };
    if state.just_hidden() {
        return;
    }
    if win.is_visible().unwrap_or(false) {
        hide_panel(app);
        return;
    }
    *state.anchor.lock().expect("tray anchor") = Some(anchor);
    move_panel(app, anchor);
    let _ = win.show();
    // Focus, because blur is how it learns to close. Without this the panel
    // would stay up until the next click on the icon, over whatever the person
    // went on to do.
    let _ = win.set_focus();
    // Ask the deck for a fresh report. It sends one every few seconds anyway;
    // this is so the panel is right at the instant it opens rather than up to a
    // tick stale, which is exactly the moment somebody is reading it.
    let _ = app.emit_to(windows::MAIN, "tray://ask", ());
}

/// Take it down, and start the re-open guard.
pub fn hide_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = panel(app) else { return };
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    let _ = win.hide();
    if let Some(state) = app.try_state::<TrayState>() {
        *state.hidden_at.lock().expect("tray hidden_at") = Some(Instant::now());
    }
}

/// The panel lost focus, so it goes. Called from the window event handler.
pub fn panel_blurred<R: Runtime>(app: &AppHandle<R>) {
    hide_panel(app);
}

/* --- The Linux menu ------------------------------------------------------- */

/// What a clickable row's id begins with. Everything after it is the row's
/// action, verbatim, and it is the only thing sent back to the deck.
#[cfg(target_os = "linux")]
const ACTION_PREFIX: &str = "tray:do:";
/// The fixed rows at the foot of the menu, which the deck does not compose.
#[cfg(target_os = "linux")]
const OPEN_ID: &str = "tray:open";
#[cfg(target_os = "linux")]
const QUIT_ID: &str = "tray:quit";

/// The action a menu id names, or `None` when the id is not a row of ours.
#[cfg(any(target_os = "linux", test))]
fn action_of(id: &str) -> Option<&str> {
    id.strip_prefix(action_prefix()).filter(|a| !a.is_empty())
}

/// The prefix, reachable from the tests on every platform. The menu itself is
/// Linux-only; the id scheme it agrees with `src/tray-panel.ts` on is not
/// something to leave untested on the machine most of this is written on.
#[cfg(any(target_os = "linux", test))]
const fn action_prefix() -> &'static str {
    "tray:do:"
}

/// The id a clickable row gets.
#[cfg(any(target_os = "linux", test))]
fn id_for(action: &str) -> String {
    format!("{}{action}", action_prefix())
}

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
#[cfg(target_os = "linux")]
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    panel: &TrayPanel,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

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

/// A menu item was chosen.
///
/// Only the two fixed items are acted on here. A row belongs to the deck — it is
/// the deck that knows which window holds a session and which provider a row is
/// about — so a row's action is forwarded and nothing is raised: raising the
/// main window before the deck routed the click to a workspace window would
/// flash the wrong window forward, which is the mistake `pill://focus-next`
/// already avoids by letting the far end raise itself.
#[cfg(target_os = "linux")]
fn on_menu<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        OPEN_ID => raise_main(app),
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

/* --- The icon ------------------------------------------------------------- */

/// Bring the deck forward. The same three calls, in the same order, as
/// `raiseThisWindow` in `src/app.ts` and the notification click handler.
fn raise_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window(windows::MAIN) else { return };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// The icon itself was clicked.
///
/// macOS opens the panel on either button, which is that platform's convention
/// for a status item. Windows keeps the two apart: right-click is where a
/// notification area icon's own thing lives, and left-click is expected to show
/// the window, so it does. Linux gets neither — an indicator's click is not
/// reliably deliverable there — which is why nothing in this design depends on
/// the distinction and why that platform has a menu instead.
#[allow(unused_variables)]
fn on_icon<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    #[cfg(not(target_os = "linux"))]
    {
        use tauri::tray::MouseButtonState;
        let TrayIconEvent::Click { button, button_state: MouseButtonState::Up, rect, .. } = event
        else {
            return;
        };
        let app = tray.app_handle();
        #[cfg(target_os = "windows")]
        if button == tauri::tray::MouseButton::Left {
            raise_main(app);
            return;
        }
        #[cfg(not(target_os = "windows"))]
        let _ = button;
        toggle_panel(app, rect);
    }
}

/// The image the status area shows: the app's own icon, in colour, drawn for this
/// size by `scripts/tray-icon.mjs`.
///
/// **Not a template image, and not `icon_as_template`.** It was one, and it was
/// wrong twice over. A template is monochrome by construction — the system reads
/// the alpha channel and tints it — so it cannot be the app's icon, which is a
/// dark frame, four black tiles, a white chevron and a *blue* cursor block. And
/// dropping the flag while keeping the black-on-transparent art, which is what
/// the panel rework did, leaves the platform drawing that art literally: a black
/// smudge in the menu bar. Colour art with no flag has neither failure. ADR-0011
/// decision 5 carries the trade this makes — no automatic light/dark adaptation,
/// paid for by the lit hairline the icon carries along its own edge.
///
/// One image for all three platforms. A Windows notification area and a Linux
/// panel tint nothing either, and a 36px drawing is a better source for them than
/// the 512px app icon downscaled by the system.
fn icon() -> Option<Image<'static>> {
    match Image::from_bytes(include_bytes!("../icons/tray-mac.png")) {
        Ok(img) => Some(img.to_owned()),
        Err(e) => {
            eprintln!("error: the status-area icon could not be decoded ({e})");
            None
        }
    }
}

/// Put the icon up, and the panel behind it. Once, during setup.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(TrayState::default());

    // Not on Linux: the panel is a menu there, and an invisible window that can
    // never be shown is a webview process for nothing.
    #[cfg(not(target_os = "linux"))]
    build_panel(app)?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        // Never a count, and never a title — the pill owns the glance. ADR-0011.
        .tooltip("cowork-deck")
        .on_tray_icon_event(on_icon);
    let builder = match icon() {
        Some(img) => builder.icon(img),
        None => builder,
    };
    // A menu attached to the icon is what swallows the click, so the two
    // platforms that can deliver one get no menu at all.
    #[cfg(target_os = "linux")]
    let builder = builder.menu(&build_menu(app, &TrayPanel::default())?).on_menu_event(on_menu);
    #[cfg(not(target_os = "linux"))]
    let builder = builder.show_menu_on_left_click(false);

    builder.build(app)?;
    Ok(())
}

/* --- What the deck has told us -------------------------------------------- */

/// The last report, and the state the two surfaces need between clicks.
///
/// Managed separately from `AppState` because none of it is the deck's state: it
/// is what this surface last drew.
#[derive(Default)]
pub struct TrayState {
    /// The last report, so an unchanged one can be dropped rather than
    /// rebuilding a menu. Only the Linux menu is rebuilt from it; the panel
    /// window redraws itself from the facts.
    panel: Mutex<TrayPanel>,
    /// Where the icon was when the panel was last opened, so a resize can put
    /// the panel back under it.
    anchor: Mutex<Option<Rect>>,
    /// When the panel last went down, for the re-open guard.
    hidden_at: Mutex<Option<Instant>>,
    /// Sessions waiting, as last reported. Held apart from `panel` because the
    /// badge is also cleared by focus and by quit, neither of which is a report.
    waiting: AtomicI64,
    /// Whether the deck is in front. A badge is a way of telling somebody who is
    /// not looking; while they are, it has nothing to say.
    focused: AtomicBool,
}

impl TrayState {
    /// Whether the panel went down so recently that this click is the one that
    /// took it down. Consumes the deadline either way: a click that is not the
    /// closing one starts from a clean slate.
    fn just_hidden(&self) -> bool {
        let mut at = self.hidden_at.lock().expect("tray hidden_at");
        match at.take() {
            Some(t) => t.elapsed() < REOPEN_GUARD,
            None => false,
        }
    }
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

/// The deck's report: what the surface says, and how many sessions are waiting.
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
    if let Err(e) = tray.set_tooltip(Some(&panel.tooltip)) {
        eprintln!("error: the tray tooltip could not be set ({e})");
    }
    #[cfg(target_os = "linux")]
    match build_menu(&app, &panel) {
        // Silent on success and loud on failure, because a menu that stopped
        // updating looks exactly like a deck with nothing to report.
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                eprintln!("error: the tray menu could not be replaced ({e})");
            }
        }
        Err(e) => eprintln!("error: the tray menu could not be built ({e})"),
    }
}

/// The panel has measured itself. Resize to fit, and stay under the icon.
///
/// Driven from the page rather than guessed here, because the height depends on
/// how many providers and how many waiting sessions there are, and only the page
/// that laid them out knows. Re-placed after the resize: on Windows the panel
/// hangs upwards from the icon, so growing it downwards would push it off the
/// bottom of the screen.
#[tauri::command]
pub fn tray_resize(app: AppHandle, height: f64) {
    let Some(win) = panel(&app) else { return };
    // No floor beyond "positive": the panel is as tall as what it drew, and on a
    // machine with no AI and no sessions that is two sentences and a footer.
    // `PANEL_HEIGHT` is only what the window opens at before the page reports.
    let h = height.max(1.0).min(PANEL_MAX_HEIGHT);
    if win.set_size(LogicalSize::new(PANEL_WIDTH, h)).is_err() {
        return;
    }
    let anchor = app
        .try_state::<TrayState>()
        .and_then(|s| *s.anchor.lock().expect("tray anchor"));
    if let Some(anchor) = anchor {
        move_panel(&app, anchor);
    }
}

/// The panel's own two controls, which are not rows and do not belong to the
/// deck: showing the window, and quitting.
///
/// Quit goes through `exit` rather than anything shorter, so the gesture arrives
/// at `RunEvent::ExitRequested` and passes `ready_to_quit` like every other way
/// out of this app. A quit that skipped it would kill live sessions without
/// asking.
#[tauri::command]
pub fn tray_activate(app: AppHandle, what: String) {
    hide_panel(&app);
    match what.as_str() {
        "open" => raise_main(&app),
        "quit" => app.exit(0),
        other => eprintln!("error: the tray panel asked for something unknown ({other})"),
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

    /* --- The id scheme the menu and the deck agree on --------------------- */

    #[test]
    fn an_action_id_round_trips() {
        assert_eq!(action_of(&id_for("usage:claude")), Some("usage:claude"));
        assert_eq!(action_of(&id_for("session:01J")), Some("session:01J"));
    }

    #[test]
    fn the_fixed_items_are_not_actions() {
        assert_eq!(action_of("tray:open"), None);
        assert_eq!(action_of("tray:quit"), None);
        assert_eq!(action_of("tray:inert:3"), None);
    }

    /// An empty action would forward an empty string to the deck, which has
    /// nothing to route it to. It is not a row anybody can mint through
    /// `id_for`, and it is refused anyway.
    #[test]
    fn an_empty_action_is_not_one() {
        assert_eq!(action_of(action_prefix()), None);
    }

    /* --- Where the panel lands -------------------------------------------- */

    /// A 1440-wide screen with a 25-point menu bar, an icon near the right.
    const WORK: (i32, i32, u32, u32) = (0, 50, 2880, 1750);

    /// Six logical pixels on the 2x display these numbers are taken from.
    const GAP: i32 = 12;

    #[test]
    fn the_panel_hangs_centred_under_the_icon() {
        let (x, y) = place((1000, 50, 44, 44), (680, 440), WORK, GAP);
        assert_eq!(x, 1000 + 22 - 340);
        assert_eq!(y, 50 + 44 + GAP);
    }

    /// The menu bar's right-hand end is where a status icon usually is, and a
    /// panel centred under one there hangs off the screen.
    #[test]
    fn a_panel_that_would_hang_off_the_right_is_pushed_back_on() {
        let (x, _) = place((2840, 50, 44, 44), (680, 440), WORK, GAP);
        assert_eq!(x, 2880 - 680 - GAP);
    }

    #[test]
    fn a_panel_that_would_hang_off_the_left_is_pushed_back_on() {
        let (x, _) = place((0, 50, 44, 44), (680, 440), WORK, GAP);
        assert_eq!(x, GAP);
    }

    /// Windows: the notification area is at the foot of the screen, so there is
    /// no room below and the panel goes above the icon instead.
    #[test]
    fn a_panel_with_no_room_below_goes_above_the_icon() {
        let work = (0, 0, 2880, 1800);
        let (_, y) = place((2800, 1740, 44, 44), (680, 440), work, GAP);
        assert_eq!(y, 1740 - 440 - GAP);
    }

    /// Both edges at once: a panel taller than the space above a bottom icon on
    /// a short screen is stopped at the top rather than drawn off it.
    #[test]
    fn a_panel_taller_than_the_screen_stops_at_the_top() {
        let work = (0, 0, 2880, 500);
        let (_, y) = place((100, 460, 40, 40), (680, 900), work, GAP);
        assert_eq!(y, GAP);
    }

    /// The second display's work area does not start at zero, and a panel that
    /// ignored that would open on the first one.
    #[test]
    fn the_panel_follows_the_icon_onto_a_second_display() {
        let right = (2880, 0, 1920, 1080);
        let (x, y) = place((3400, 0, 44, 44), (680, 440), right, GAP);
        assert_eq!(x, 3400 + 22 - 340);
        assert_eq!(y, 44 + GAP);
    }

    /* --- The badge -------------------------------------------------------- */

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

    /* --- The re-open guard ------------------------------------------------ */

    /// Clicking the icon while the panel is up blurs it first, so the panel
    /// hides and the click then arrives. Without the guard it would reopen, and
    /// the gesture the person made was "close it".
    #[test]
    fn a_click_that_closed_the_panel_does_not_reopen_it() {
        let state = TrayState::default();
        *state.hidden_at.lock().unwrap() = Some(Instant::now());
        assert!(state.just_hidden());
    }

    /// And the deadline is consumed, so the NEXT click opens it again.
    #[test]
    fn the_guard_lasts_exactly_one_click() {
        let state = TrayState::default();
        *state.hidden_at.lock().unwrap() = Some(Instant::now());
        assert!(state.just_hidden());
        assert!(!state.just_hidden());
    }

    #[test]
    fn a_click_with_the_panel_long_gone_is_not_guarded() {
        let state = TrayState::default();
        *state.hidden_at.lock().unwrap() = Some(Instant::now() - REOPEN_GUARD * 2);
        assert!(!state.just_hidden());
    }

    #[test]
    fn a_first_click_is_not_guarded() {
        assert!(!TrayState::default().just_hidden());
    }
}
