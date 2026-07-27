use std::collections::BTreeMap;
use std::path::Path;

/// Byte offsets of every line start in `s`.
pub fn line_starts(s: &str) -> Vec<usize> {
    let mut v = vec![0usize];
    for (i, c) in s.char_indices() {
        if c == '\n' {
            v.push(i + 1);
        }
    }
    v
}

/// Top-level `key: value` frontmatter and the body that follows it.
pub fn parse_frontmatter(text: &str) -> (BTreeMap<String, String>, &str) {
    let mut fm = BTreeMap::new();
    let Some(rest) = text.strip_prefix("---\n") else {
        return (fm, text);
    };
    let Some(end) = rest.find("\n---\n") else {
        return (fm, text);
    };
    for line in rest[..end].lines() {
        if line.starts_with(' ') || line.starts_with('\t') || line.starts_with('-') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
            fm.insert(k.trim().to_string(), v.to_string());
        }
    }
    (fm, &rest[end + "\n---\n".len()..])
}

/// First `# ` heading, or the file stem when there is none.
pub fn find_title(body: &str, rel_path: &str) -> String {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            // Python's `^# (.+)$` requires at least one character after the space.
            if !rest.is_empty() {
                return rest.trim().to_string();
            }
        }
    }
    Path::new(rel_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_top_level_frontmatter_and_returns_body() {
        let text = "---\ntags: [meta, memory]\nproject: \"cowork-deck\"\n  nested: ignored\n- item: ignored\n---\n# Title\n\nbody\n";
        let (fm, body) = parse_frontmatter(text);

        assert_eq!(fm.get("project").map(String::as_str), Some("cowork-deck"));
        assert_eq!(fm.get("tags").map(String::as_str), Some("[meta, memory]"));
        assert!(!fm.contains_key("nested"), "indented lines are continuations");
        assert!(!fm.contains_key("- item"), "list lines are not top-level keys");
        assert!(body.starts_with("# Title"), "body was: {body:?}");
    }

    #[test]
    fn returns_whole_text_when_there_is_no_frontmatter() {
        let text = "# Title\n\nbody\n";
        let (fm, body) = parse_frontmatter(text);
        assert!(fm.is_empty());
        assert_eq!(body, text);
    }

    #[test]
    fn title_comes_from_first_heading_then_falls_back_to_file_stem() {
        assert_eq!(find_title("# Первый\n\n# Второй\n", "a/b/note.md"), "Первый");
        assert_eq!(find_title("no heading here\n", "a/b/26-topic.md"), "26-topic");
        assert_eq!(find_title("#нет пробела\n", "a/b/26-topic.md"), "26-topic");
    }
}
