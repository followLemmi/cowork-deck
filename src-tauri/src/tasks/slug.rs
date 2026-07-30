//! One `slug`, shared by the pull request and the issue paths. It lives in the
//! library because `tasks` may not reach into the binary's private modules, and
//! both kinds of branch name have to be slugged the same way.

/// A filesystem-safe fragment of a branch name: lowercase, single dashes, and
/// short enough to keep the path within sane limits. Path separators and dots
/// are stripped rather than escaped, so nothing here can climb out of the
/// directory it is joined to.
pub fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let cut = trimmed.char_indices().nth(40).map_or(trimmed.len(), |(i, _)| i);
    let cut = trimmed[..cut].trim_end_matches('-');
    if cut.is_empty() {
        "branch".to_string()
    } else {
        cut.to_string()
    }
}
