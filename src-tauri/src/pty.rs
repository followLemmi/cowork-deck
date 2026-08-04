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
}
