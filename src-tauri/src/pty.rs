use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl PtyManager {
    pub fn new() -> PtyManager {
        PtyManager { sessions: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn spawn<F>(
        &self,
        session: &str,
        program: &str,
        args: &[String],
        cwd: &str,
        cols: u16,
        rows: u16,
        env: &[(String, String)],
        on_output: F,
        on_exit: impl Fn(bool) + Send + 'static,
    ) -> std::io::Result<()>
    where
        F: Fn(Vec<u8>) + Send + 'static,
    {
        // Avoid orphaning a previously spawned process under the same session id.
        self.kill(session);

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(to_io)?;

        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.cwd(cwd);

        // What kind of terminal is on the other end of this pty, declared here
        // because here is where the pty is made and xterm.js is the answer for
        // every caller.
        //
        // Nothing set it before, and nothing else would: `CommandBuilder`
        // inherits the app's own environment and adds none of its own, and an
        // .app launched from the Dock inherits launchd's, which has no `TERM` at
        // all. A program with no `TERM` turns colour off — Claude Code decides
        // through `supports-color`, which reports level 0 and paints its whole
        // TUI monochrome. The symptom read as a broken theme and was an empty
        // variable. It is the same launchd-minimal environment that the `PATH`
        // push in `commands.rs` already exists to work around, which is why the
        // colour was there under `tauri dev` (a shell's `TERM`, inherited) and
        // gone in the shipped bundle.
        //
        // Declared, not defaulted: an inherited `TERM` describes whatever
        // terminal launched the *app* — `dumb`, or `eterm-color` under Emacs —
        // and none of them describes the thing actually drawing these bytes. Set
        // before the caller's overrides, so a session can still name its own.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // Переменные задаются ТОЛЬКО дочернему процессу. Окружение самого
        // приложения и других сессий не затрагивается — именно на этом стоит
        // изоляция GitHub-аккаунтов между воркспейсами.
        for (k, v) in env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(to_io)?;
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(to_io)?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().map_err(to_io)?));

        // Reader thread: stream output until EOF.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(buf[..n].to_vec()),
                }
            }
        });

        // Waiter thread: report exit status.
        std::thread::spawn(move || {
            let status = child.wait();
            let ok = status.map(|s| s.success()).unwrap_or(false);
            on_exit(ok);
        });

        self.sessions.lock().unwrap().insert(
            session.to_string(),
            Session { master: pair.master, writer, killer },
        );
        Ok(())
    }

    pub fn write(&self, session: &str, data: &[u8]) -> std::io::Result<()> {
        // Only hold the map lock long enough to clone out this session's writer
        // handle. The blocking IO below runs against the per-session writer
        // mutex, so a wedged write can never stall other sessions, resizes,
        // kill(), or kill_all().
        let writer = {
            let map = self.sessions.lock().unwrap();
            match map.get(session) {
                Some(s) => Arc::clone(&s.writer),
                None => return Ok(()),
            }
        };

        let mut w = writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, session: &str, cols: u16, rows: u16) -> std::io::Result<()> {
        let map = self.sessions.lock().unwrap();
        if let Some(s) = map.get(session) {
            s.master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(to_io)?;
        }
        Ok(())
    }

    pub fn kill(&self, session: &str) {
        // Remove the entry and drop the map guard before killing, so a stuck
        // writer holding only its own per-session lock can never block this.
        let removed = {
            let mut map = self.sessions.lock().unwrap();
            map.remove(session)
        };
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
        }
    }

    pub fn kill_all(&self) {
        // Drain into a local Vec and drop the map guard before killing any
        // child, so kill_all can never be blocked by a stuck per-session write.
        let removed: Vec<Session> = {
            let mut map = self.sessions.lock().unwrap();
            map.drain().map(|(_, s)| s).collect()
        };
        for mut s in removed {
            let _ = s.killer.kill();
        }
    }
}

fn to_io<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawns_streams_output_and_exits() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<bool>();

        #[cfg(windows)]
        let (prog, args) = ("cmd", vec!["/C".to_string(), "echo COWORK_OK".to_string()]);
        #[cfg(not(windows))]
        let (prog, args) = ("/bin/sh", vec!["-c".to_string(), "printf COWORK_OK".to_string()]);

        mgr.spawn(
            "s1", prog, &args, ".", 80, 24, &[],
            move |bytes| { let _ = tx.send(bytes); },
            move |ok| { let _ = etx.send(ok); },
        ).unwrap();

        let mut got = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                got.extend_from_slice(&b);
                if String::from_utf8_lossy(&got).contains("COWORK_OK") { break; }
            }
        }
        assert!(String::from_utf8_lossy(&got).contains("COWORK_OK"), "got: {:?}", String::from_utf8_lossy(&got));
        assert!(erx.recv_timeout(Duration::from_secs(5)).is_ok(), "exit not reported");
    }

    #[test]
    fn injected_env_reaches_the_child_process() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<bool>();

        #[cfg(windows)]
        let (prog, args) = ("cmd", vec!["/C".to_string(), "echo %COWORK_TEST_VAR%".to_string()]);
        #[cfg(not(windows))]
        let (prog, args) =
            ("/bin/sh", vec!["-c".to_string(), "printf %s \"$COWORK_TEST_VAR\"".to_string()]);

        mgr.spawn(
            "envtest",
            prog,
            &args,
            ".",
            80,
            24,
            &[("COWORK_TEST_VAR".to_string(), "injected-value".to_string())],
            move |bytes| { let _ = tx.send(bytes); },
            move |ok| { let _ = etx.send(ok); },
        )
        .unwrap();

        let mut got = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                got.extend_from_slice(&b);
                if String::from_utf8_lossy(&got).contains("injected-value") { break; }
            }
        }
        assert!(
            String::from_utf8_lossy(&got).contains("injected-value"),
            "дочерний процесс не увидел инжектированную переменную: {:?}",
            String::from_utf8_lossy(&got)
        );
        assert!(erx.recv_timeout(Duration::from_secs(5)).is_ok(), "exit not reported");
    }

    /// Spawn a shell that prints `TERM` and `COLORTERM`, and return what it printed.
    fn echo_terminal_env(session: &str, env: &[(String, String)]) -> String {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        #[cfg(windows)]
        let (prog, args) = ("cmd", vec!["/C".to_string(), "echo %TERM% %COLORTERM%".to_string()]);
        #[cfg(not(windows))]
        let (prog, args) = (
            "/bin/sh",
            vec!["-c".to_string(), r#"printf '%s %s' "$TERM" "$COLORTERM""#.to_string()],
        );

        mgr.spawn(session, prog, &args, ".", 80, 24, env, move |b| { let _ = tx.send(b); }, |_| {})
            .unwrap();

        let mut got = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                got.extend_from_slice(&b);
                // Both values are on one line, so the newline that ends it ends the read.
                if got.contains(&b'\n') || String::from_utf8_lossy(&got).contains("truecolor") {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&got).to_string()
    }

    /// Run `f` with the test process itself carrying a `TERM` the child must not
    /// inherit. Without this the terminal-type tests pass in any shell that has a
    /// `TERM` of its own — the child would inherit it and the assertion would hold
    /// with the declaration removed, which is a green test for a broken app. The
    /// lock keeps the two of them from editing one process's environment at once;
    /// the other tests here spawn shells that never read `TERM`, so a sentinel
    /// leaking into one of those costs nothing.
    fn with_parent_term<T>(sentinel: &str, f: impl FnOnce() -> T) -> T {
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let restore = std::env::var_os("TERM");
        std::env::set_var("TERM", sentinel);
        let out = f();
        match restore {
            Some(v) => std::env::set_var("TERM", v),
            None => std::env::remove_var("TERM"),
        }
        out
    }

    /// Without this the child inherits the app's environment, and an .app launched
    /// from the Dock has no `TERM` — which is a monochrome agent, because
    /// `supports-color` reads exactly this variable to decide whether colour exists.
    #[test]
    fn the_child_is_told_which_terminal_it_is_talking_to() {
        let out = with_parent_term("cowork-parent-sentinel", || echo_terminal_env("termtest", &[]));
        assert!(out.contains("xterm-256color"), "TERM not set for the session: {out:?}");
        assert!(out.contains("truecolor"), "COLORTERM not set for the session: {out:?}");
        assert!(
            !out.contains("cowork-parent-sentinel"),
            "the session inherited the app's own TERM instead of being told one: {out:?}"
        );
    }

    /// The declaration is a default, not a decree: it is written before the
    /// caller's environment is applied, so a session that has reason to claim a
    /// different terminal still can.
    #[test]
    fn a_caller_may_override_the_terminal_type() {
        let out = with_parent_term("cowork-parent-sentinel", || {
            echo_terminal_env("termoverride", &[("TERM".to_string(), "xterm-mono".to_string())])
        });
        assert!(out.contains("xterm-mono"), "caller's TERM did not win: {out:?}");
        assert!(!out.contains("xterm-256color"), "default TERM survived the override: {out:?}");
    }
}
