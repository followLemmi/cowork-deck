use std::collections::HashMap;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

/// Return a runnable terminal command template for the current OS. Used when the
/// user's template is empty ("auto"). Each candidate carries the correct flag to
/// run a command in that terminal.
pub fn detect_default_terminal() -> String {
    #[cfg(target_os = "windows")]
    {
        if which("wt") { return "wt".into(); }
        return "cmd /c start".into();
    }
    #[cfg(target_os = "macos")]
    {
        // Best-effort: Terminal.app via `open` needs a script wrapper for args, which
        // does not fit the prefix model. Fall back to a common terminal if present,
        // else return a Terminal.app hint the user can refine.
        for (bin, tmpl) in [("ghostty","ghostty -e"),("wezterm","wezterm start --"),("kitty","kitty"),("alacritty","alacritty -e")] {
            if which(bin) { return tmpl.into(); }
        }
        return "open -a Terminal".into();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(t) = std::env::var("TERMINAL") {
            if !t.trim().is_empty() { return format!("{} -e", t.trim()); }
        }
        if which("x-terminal-emulator") { return "x-terminal-emulator -e".into(); }
        for (bin, tmpl) in [
            ("ghostty","ghostty -e"), ("wezterm","wezterm start --"), ("kitty","kitty"),
            ("alacritty","alacritty -e"), ("gnome-terminal","gnome-terminal --"),
            ("konsole","konsole -e"), ("xterm","xterm -e"),
        ] {
            if which(bin) { return tmpl.into(); }
        }
        return "xterm -e".into();
    }
}

/// Is `bin` resolvable on PATH? Scans `$PATH` directly (no shell builtin, no crate).
fn which(bin: &str) -> bool {
    let path = match std::env::var_os("PATH") { Some(p) => p, None => return false };
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() { return true; }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                if dir.join(format!("{bin}.{ext}")).is_file() { return true; }
            }
        }
    }
    false
}

/// Split the terminal command template and append the claude invocation.
pub fn build_launch_argv(
    template: &str, program: &str, settings_file: &str, prompt: &Option<String>,
) -> Result<Vec<String>, String> {
    let mut argv = shell_words::split(template).map_err(|e| e.to_string())?;
    if argv.is_empty() {
        return Err("empty terminal command".into());
    }
    argv.push(program.to_string());
    argv.push("--settings".to_string());
    argv.push(settings_file.to_string());
    if let Some(p) = prompt {
        argv.push(p.clone());
    }
    Ok(argv)
}

#[derive(Clone)]
pub struct ExternalManager {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

impl ExternalManager {
    pub fn new() -> ExternalManager {
        ExternalManager { children: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn launch(&self, session: &str, argv: &[String], cwd: &str) -> std::io::Result<()> {
        // Replace any previous terminal for this session id.
        self.kill(session);
        let child = Command::new(&argv[0]).args(&argv[1..]).current_dir(cwd).spawn()?;
        self.children.lock().unwrap().insert(session.to_string(), child);
        Ok(())
    }

    pub fn kill(&self, session: &str) {
        if let Some(mut c) = self.children.lock().unwrap().remove(session) {
            let _ = c.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut map = self.children.lock().unwrap();
        for (_, mut c) in map.drain() {
            let _ = c.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builds_argv_from_template() {
        let argv = build_launch_argv("ghostty -e", "claude", "/tmp/s.json", &Some("do it".into())).unwrap();
        assert_eq!(argv, vec!["ghostty","-e","claude","--settings","/tmp/s.json","do it"]);
        let argv2 = build_launch_argv("wezterm start --", "claude", "/tmp/s.json", &None).unwrap();
        assert_eq!(argv2, vec!["wezterm","start","--","claude","--settings","/tmp/s.json"]);
        assert!(build_launch_argv("   ", "claude", "/tmp/s.json", &None).is_err());
    }
    #[test]
    fn detect_returns_nonempty() {
        // On any supported OS the resolver must yield a runnable prefix.
        assert!(!detect_default_terminal().trim().is_empty());
    }
    #[test]
    fn manager_launches_and_kills() {
        let m = ExternalManager::new();
        #[cfg(windows)]
        let argv: Vec<String> = ["cmd","/C","ping 127.0.0.1 -n 6"].iter().map(|s| s.to_string()).collect();
        #[cfg(not(windows))]
        let argv: Vec<String> = ["sh","-c","sleep 5"].iter().map(|s| s.to_string()).collect();
        m.launch("s1", &argv, ".").unwrap();
        m.kill_all(); // must not panic; child killed
    }
}
