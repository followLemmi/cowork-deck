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

use crate::{CHUNK_MAX, BIG_FILE, INFO_MIN, TLDR_MIN};
use std::collections::HashSet;

/// First `n` characters (not bytes) of `s`.
fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Count of alphabetic characters — Python's `[^\W\d_]` under Unicode.
pub fn letters(s: &str) -> usize {
    s.chars().filter(|c| c.is_alphabetic()).count()
}

/// Raw content of the `## TL;DR` section, untrimmed, or None.
///
/// Ports `^##+\s*TL;DR\s*\n(.*?)(?=^## |\Z)`. The `regex` crate has no
/// lookahead, so the terminator is found by scanning line starts.
pub fn find_tldr(body: &str) -> Option<String> {
    let starts = line_starts(body);
    for (li, &st) in starts.iter().enumerate() {
        let line_end = body[st..].find('\n').map(|p| st + p).unwrap_or(body.len());
        let t = body[st..line_end].trim_end();

        let hashes = t.len() - t.trim_start_matches('#').len();
        if hashes < 2 {
            continue;
        }
        let after = t[hashes..].trim_start();
        let Some(tail) = after.strip_prefix("TL;DR") else {
            continue;
        };
        if !tail.trim().is_empty() {
            continue;
        }

        let content_start = (line_end + 1).min(body.len());
        let mut content_end = body.len();
        for &s2 in &starts[li + 1..] {
            if s2 >= content_start && body[s2..].starts_with("## ") {
                content_end = s2;
                break;
            }
        }
        return Some(body[content_start..content_end].to_string());
    }
    None
}

/// Split before every line starting with `## `.
///
/// Ports `re.split(r"(?=^## )", body)`. Python emits a leading empty string
/// when the body starts with `## `; this does not, which is equivalent because
/// an empty section contributes nothing to the accumulator.
pub fn split_sections(body: &str) -> Vec<&str> {
    let mut cuts = vec![0usize];
    for &st in line_starts(body).iter() {
        if st > 0 && body[st..].starts_with("## ") {
            cuts.push(st);
        }
    }
    let mut out = Vec::with_capacity(cuts.len());
    for (i, &c) in cuts.iter().enumerate() {
        let e = cuts.get(i + 1).copied().unwrap_or(body.len());
        if c < e {
            out.push(&body[c..e]);
        }
    }
    out
}

fn wrap(title: &str, buf: &str) -> String {
    if buf.trim_start().starts_with('#') {
        buf.trim().to_string()
    } else {
        format!("{title}\n{}", buf.trim())
    }
}

/// Ordered, filtered, deduped chunks for one note. The TL;DR section, when
/// present and non-empty, is always the first chunk.
pub fn chunk_note(rel_path: &str, text: &str) -> Vec<String> {
    let (_fm, body) = parse_frontmatter(text);
    let title = find_title(body, rel_path);

    let tldr = find_tldr(body);
    let tldr_content = tldr.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let has_tldr_chunk = tldr_content.is_some();

    let mut chunks: Vec<String> = Vec::new();
    if let Some(t) = tldr_content {
        chunks.push(format!("{title}\n{t}"));
    }

    if text.len() > BIG_FILE {
        // Bytes here, matching Python's len(text.encode()).
        if chunks.is_empty() {
            chunks.push(format!("{title}\n{}", take_chars(body, 1500)));
        }
    } else if body.chars().count() <= CHUNK_MAX {
        let b = body.trim();
        chunks.push(if b.is_empty() { title.clone() } else { b.to_string() });
    } else {
        let mut buf = String::new();
        for s in split_sections(body) {
            if buf.chars().count() + s.chars().count() <= CHUNK_MAX {
                buf.push_str(s);
            } else {
                if !buf.trim().is_empty() {
                    chunks.push(wrap(&title, &buf));
                }
                buf = s.to_string();
            }
        }
        if !buf.trim().is_empty() {
            chunks.push(wrap(&title, &buf));
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (idx, c) in chunks.iter().enumerate() {
        let c = take_chars(c, CHUNK_MAX).trim().to_string();
        // Gate on a TL;DR chunk having actually been emitted, not on the
        // heading merely being present — see the reference fix of 2026-07-27.
        let is_tldr = has_tldr_chunk && idx == 0;
        let min = if is_tldr { TLDR_MIN } else { INFO_MIN };
        if letters(&c) < min {
            continue;
        }
        if !c.is_empty() && seen.insert(c.clone()) {
            out.push(c);
        }
    }
    out
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

    #[test]
    fn tldr_stops_at_the_next_section() {
        let body = "# T\n\n## TL;DR\nline one\nline two\n\n## Next\nnot this\n";
        let t = find_tldr(body).unwrap();
        assert!(t.contains("line one") && t.contains("line two"));
        assert!(!t.contains("not this"));
    }

    #[test]
    fn tldr_absent_gives_none() {
        assert!(find_tldr("# T\n\n## Other\ntext\n").is_none());
    }

    #[test]
    fn sections_split_before_each_heading() {
        let s = split_sections("intro\n## A\naaa\n## B\nbbb\n");
        assert_eq!(s.len(), 3);
        assert!(s[0].starts_with("intro"));
        assert!(s[1].starts_with("## A"));
        assert!(s[2].starts_with("## B"));
    }

    #[test]
    fn letters_counts_cyrillic_and_ignores_digits_and_punctuation() {
        assert_eq!(letters("абв ABC 123 _-!"), 6);
    }
}
