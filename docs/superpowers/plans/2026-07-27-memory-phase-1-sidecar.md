# Project Memory Phase 1 — `cowork_memory` sidecar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `cowork_memory` binary that indexes a markdown memory corpus and answers semantic search queries, reproducing the behaviour of the author's proven `vault-index` Python tool.

**Architecture:** A new crate, `crates/cowork-memory`, independent of the Tauri app crate. Markdown is the source of truth; the index (`meta.json` + `emb.bin`) is a disposable cache rebuilt from it. Embedding runs through an `Embedder` trait with two implementations: a deterministic `FakeEmbedder` for tests and an `OnnxEmbedder` that loads a downloaded model. No app code is touched in this phase.

**Tech Stack:** Rust 2021, `serde`/`serde_json`, `clap` (derive), `ort` (ONNX Runtime), `tokenizers` (HuggingFace), `ureq` (model download).

**Spec:** `docs/superpowers/specs/2026-07-27-project-memory-design.md`, "Phase 1".

## Global Constraints

- **Separate crate, not a module of `src-tauri`.** `crates/cowork-memory/` has its own `Cargo.toml`, its own `Cargo.lock` and its own `target/`. Do **not** add a root `[workspace]` — that would move `src-tauri`'s target directory and break `scripts/stage-reporter.sh`, which hardcodes `src-tauri/target/release/`.
- **The app crate must not depend on this crate.** Keeping `ort` out of the main binary is the entire reason the sidecar exists.
- **Character counts, not byte counts.** Every length limit in the Python original operates on Unicode code points (`len(str)`), except the `BIG_FILE` check, which is bytes (`len(text.encode())`). Using `str.len()` in Rust where Python used `len()` silently truncates Russian text at half the intended length. Use `.chars().count()` and `.chars().take(n)`.
- **The `regex` crate has no lookahead.** Three of the Python patterns use `(?=...)` or need it. They must be hand-rolled. This is precisely where a port drifts silently, which is why Task 3 is golden-tested against the Python output.
- **Ported constants, exact values:** `BIG_FILE = 30_000` bytes, `CHUNK_MAX = 2000` chars, `SNIPPET = 300` chars, `INFO_MIN = 120` letters, TL;DR minimum `40` letters, big-file head `1500` chars, embedding batch `16`, tokenizer truncation `256`, search defaults `top = 10`, `min_score = 0.25`.
- **Model:** `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, files `onnx/model.onnx` (470 301 610 bytes) and `tokenizer.json` (9 081 518 bytes). Embedding dim 384.
- **Never commit vault content.** Golden fixtures are synthetic notes written for this repo, not copies of the author's notes.

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/cowork-memory/Cargo.toml` | Crate manifest |
| `crates/cowork-memory/src/lib.rs` | Module wiring, shared constants |
| `crates/cowork-memory/src/corpus.rs` | Frontmatter, title, TL;DR, section splitting, chunking, noise filter |
| `crates/cowork-memory/src/scan.rs` | Walking the memory directory, scope detection, file stats |
| `crates/cowork-memory/src/embed.rs` | `Embedder` trait, `FakeEmbedder` |
| `crates/cowork-memory/src/onnx.rs` | `OnnxEmbedder` |
| `crates/cowork-memory/src/model.rs` | Model download: resume, atomic rename, verification |
| `crates/cowork-memory/src/index.rs` | `meta.json` + `emb.bin` store, incremental update, cosine search |
| `crates/cowork-memory/src/main.rs` | CLI |
| `crates/cowork-memory/tests/fixtures/notes/*.md` | Synthetic corpus for golden tests |
| `crates/cowork-memory/tests/fixtures/golden.json` | Expected chunk output, generated from the Python original |
| `crates/cowork-memory/tests/golden.rs` | Parity test |
| `crates/cowork-memory/tests/cli.rs` | End-to-end CLI tests |
| `scripts/stage-memory.sh` | Builds and stages the sidecar, mirroring `stage-reporter.sh` |

---

### Task 1: Crate skeleton and the `Embedder` trait

**Files:**
- Create: `crates/cowork-memory/Cargo.toml`
- Create: `crates/cowork-memory/src/lib.rs`
- Create: `crates/cowork-memory/src/embed.rs`
- Create: `crates/cowork-memory/src/main.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub trait Embedder { fn dim(&self) -> usize; fn embed(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>>; }`
  - `pub struct FakeEmbedder;` with `pub fn new() -> FakeEmbedder`
  - Constants in `lib.rs`: `BIG_FILE: usize`, `CHUNK_MAX: usize`, `SNIPPET: usize`, `INFO_MIN: usize`, `TLDR_MIN: usize`, `DIARY_SCOPE: &str`.

`FakeEmbedder` returns deterministic unit vectors of dim 64. It does **not** reproduce numpy's random number generator — the Python `FakeEmbedder` uses `numpy.default_rng(seed).standard_normal(64)`, and matching numpy's PCG64 output in Rust is neither feasible nor needed. Determinism within Rust is the only requirement; the golden tests in Task 3 compare *chunk text*, not vectors.

- [ ] **Step 1: Write the failing test**

Create `crates/cowork-memory/src/embed.rs`:

```rust
use anyhow::Result;

pub trait Embedder {
    fn dim(&self) -> usize;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_embedder_is_deterministic_and_normalised() {
        let e = FakeEmbedder::new();
        let texts = vec!["привет мир".to_string(), "hello world".to_string()];

        let a = e.embed(&texts).unwrap();
        let b = e.embed(&texts).unwrap();
        assert_eq!(a, b, "same input must give the same vectors");

        assert_eq!(a.len(), 2);
        assert_eq!(a[0].len(), e.dim());
        assert_ne!(a[0], a[1], "different text must give different vectors");

        let norm: f32 = a[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "vector must be unit length, got {norm}");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml`
Expected: FAIL — `cannot find struct FakeEmbedder`.

- [ ] **Step 3: Write minimal implementation**

`crates/cowork-memory/Cargo.toml`:

```toml
[package]
name = "cowork-memory"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "cowork_memory"
path = "src/main.rs"

[lib]
name = "cowork_memory"
path = "src/lib.rs"

[dependencies]
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
clap = { version = "4", features = ["derive"] }
```

Append to `crates/cowork-memory/src/embed.rs`, above the test module:

```rust
pub struct FakeEmbedder {
    dim: usize,
}

impl FakeEmbedder {
    pub fn new() -> FakeEmbedder {
        FakeEmbedder { dim: 64 }
    }
}

impl Default for FakeEmbedder {
    fn default() -> Self {
        Self::new()
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

impl Embedder for FakeEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for t in texts {
            let mut state = fnv1a(t.as_bytes());
            let mut v: Vec<f32> = (0..self.dim)
                .map(|_| {
                    let r = splitmix64(&mut state) >> 11;
                    ((r as f64 / (1u64 << 53) as f64) * 2.0 - 1.0) as f32
                })
                .collect();
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
            for x in v.iter_mut() {
                *x /= norm;
            }
            out.push(v);
        }
        Ok(out)
    }
}
```

`crates/cowork-memory/src/lib.rs`:

```rust
pub mod embed;

/// Bytes. Above this, only the TL;DR plus a head excerpt is indexed.
pub const BIG_FILE: usize = 30_000;
/// Characters per chunk.
pub const CHUNK_MAX: usize = 2000;
/// Characters shown per search hit.
pub const SNIPPET: usize = 300;
/// Minimum letters per chunk — filters markdown skeletons out of the results.
pub const INFO_MIN: usize = 120;
/// Minimum letters for a TL;DR chunk, which is allowed to be terser.
pub const TLDR_MIN: usize = 40;
/// Scope value used for global, cross-project diary chunks.
pub const DIARY_SCOPE: &str = "__diaries__";
```

`crates/cowork-memory/src/main.rs`:

```rust
fn main() {
    println!("cowork_memory");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): cowork-memory crate skeleton with Embedder trait and FakeEmbedder"
```

---

### Task 2: Frontmatter and title extraction

**Files:**
- Create: `crates/cowork-memory/src/corpus.rs`
- Modify: `crates/cowork-memory/src/lib.rs` (add `pub mod corpus;`)

**Interfaces:**
- Consumes: constants from `lib.rs`.
- Produces:
  - `pub fn parse_frontmatter(text: &str) -> (std::collections::BTreeMap<String, String>, &str)` — returns the top-level `key: value` pairs and the body after the closing `---`.
  - `pub fn find_title(body: &str, rel_path: &str) -> String` — the first `# ` heading, else the file stem.
  - `pub fn line_starts(s: &str) -> Vec<usize>` — byte offsets of every line start; used by Tasks 2 and 3.

Ported from `parse_frontmatter` and the title regex in `vault_index.py`. The Python frontmatter regex is `\A---\n(.*?)\n---\n`; it skips continuation lines (leading space, tab or `-`) and strips one layer of surrounding quotes.

- [ ] **Step 1: Write the failing test**

Create `crates/cowork-memory/src/corpus.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml corpus`
Expected: FAIL — `cannot find function parse_frontmatter`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `crates/cowork-memory/src/corpus.rs`:

```rust
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
```

Add to `crates/cowork-memory/src/lib.rs`:

```rust
pub mod corpus;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml corpus`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): frontmatter parsing and title extraction"
```

---

### Task 3: Chunking, with golden parity against the Python original

This is the highest-risk task in the phase. Everything downstream depends on chunk boundaries matching the tool that is known to give good search results.

**Files:**
- Modify: `crates/cowork-memory/src/corpus.rs`
- Create: `crates/cowork-memory/tests/fixtures/notes/*.md` (six synthetic notes)
- Create: `crates/cowork-memory/tests/fixtures/golden.json`
- Create: `crates/cowork-memory/tests/golden.rs`

**Interfaces:**
- Consumes: `parse_frontmatter`, `find_title`, `line_starts` from Task 2; constants from `lib.rs`.
- Produces:
  - `pub fn find_tldr(body: &str) -> Option<String>` — raw TL;DR section content, untrimmed.
  - `pub fn split_sections(body: &str) -> Vec<&str>` — split before each line starting with `## `.
  - `pub fn letters(s: &str) -> usize` — count of alphabetic characters.
  - `pub fn chunk_note(rel_path: &str, text: &str) -> Vec<String>` — the ordered, filtered, deduped chunks for one note.

**Two faithfulness notes, both deliberate:**

1. Python's `re.split(r"(?=^## )", body)` yields a leading empty string when the body starts with `## `. The Rust version does not. This is harmless — an empty section contributes nothing to the accumulator — and the golden test proves it.
2. Python computes `is_tldr = bool(tldr) and idx == 0`, where `tldr` is the *match object*. If a `## TL;DR` heading exists but its content is blank, no TL;DR chunk is emitted, yet index 0 — a different chunk — still receives the lenient 40-letter threshold. Reproduce this. It is an edge case of the tool being ported, and diverging would fail the golden test.

- [ ] **Step 1: Write the fixture notes**

Create six files under `crates/cowork-memory/tests/fixtures/notes/`. These are synthetic; do not copy real notes.

`01-tldr-and-sections.md`:

```markdown
---
tags: [session]
---
# Запуск планировщика

## TL;DR
Планировщик жил в приложении, поэтому пропущенные запуски догонялись на старте.
Одна сессия на сценарий: если предыдущая ещё работает, новый запуск пропускается.
Кнопка ⏰ гоняет сценарий немедленно и не тратит следующий запланированный запуск.

## Контекст
Расписание должно было работать без облака, на машине пользователя, через его же
Claude Code. Это ограничение определило всю конструкцию: планировщик внутри окна,
никаких демонов, никаких хостед-раннеров, полный локальный контекст и разрешения.

## Решение
Состояние хранится в schedule_state.json рядом с остальным состоянием приложения.
При старте приложение сравнивает текущее время с последним запуском каждого
сценария и догоняет ровно один пропущенный запуск, сколько бы их ни накопилось.
```

`02-no-tldr-short.md`:

```markdown
# Короткая заметка

Здесь нет секции TL;DR, и весь текст помещается в один чанк целиком, потому что
длина тела заметки заметно меньше двух тысяч символов. Такой файл должен дать
ровно один чанк, и этот чанк должен содержать тело заметки без заголовка сверху.
```

`03-noise-only.md`:

```markdown
# Шаблон

## Что сделано
- [ ]
- [ ]

## Что дальше
- [ ]
```

`04-empty-tldr.md`:

```markdown
# Пустой TL;DR

## TL;DR

## Содержание
Секция TL;DR присутствует, но пуста. По правилам питоновской реализации чанк
для неё не создаётся, однако порог в сорок букв всё равно применяется к первому
чанку. Этот файл существует ровно для того, чтобы зафиксировать это поведение.
```

`05-starts-with-section.md`:

```markdown
## Первая секция
Тело заметки начинается сразу с секции второго уровня, без заголовка первого
уровня. Заголовок в этом случае берётся из имени файла, а разбиение по секциям
должно дать корректный результат без ведущего пустого элемента.

## Вторая секция
Ещё немного текста, чтобы заметка не оказалась целиком в одном чанке и чтобы
ветка разбиения по секциям действительно выполнилась при достаточной длине.
```

`06-latin-mixed.md`:

```markdown
---
project: cowork-deck
---
# Mixed script note

## TL;DR
The sidecar keeps ONNX out of the main binary; the app only spawns it.
Markdown is the source of truth and the index is a disposable cache.

## Detail
Русский и латиница в одном файле проверяют, что счётчик букв и обрезка по
символам работают на многобайтовых строках так же, как в питоновской версии.
```

- [ ] **Step 2: Generate the two long fixtures**

The six notes above are all under 2000 characters, so they only exercise the
"whole body is one chunk" branch. The section-splitting branch — where Python's
`re.split(r"(?=^## )")` had to be hand-rolled — and the big-file branch need
fixtures of their own, and those are generated rather than typed:

```bash
python3 - <<'PY'
import pathlib
d = pathlib.Path("crates/cowork-memory/tests/fixtures/notes")

para = ("Планировщик живёт внутри приложения, поэтому пропущенные запуски догоняются "
        "при следующем старте, а не теряются насовсем. Это осознанное ограничение: "
        "никаких демонов и никаких хостед-раннеров. ")

# Body well over CHUNK_MAX (2000 chars) across several sections, so the
# accumulate-and-flush loop runs more than once.
secs = "".join(f"## Секция {i}\n{para * 4}\n\n" for i in range(1, 6))
(d / "07-long-many-sections.md").write_text(f"# Длинная заметка\n\n{secs}")

# Over BIG_FILE (30 000 bytes) with a TL;DR, so only the TL;DR chunk survives.
big = "".join(f"## Раздел {i}\n{para * 8}\n\n" for i in range(1, 30))
(d / "08-big-file.md").write_text(
    "# Очень большая заметка\n\n## TL;DR\n"
    "Файл больше тридцати килобайт, поэтому индексируется только эта секция.\n"
    "Остальное тело в индекс не попадает вовсе, и это ожидаемое поведение.\n\n"
    + big
)

for p in sorted(d.glob("*.md")):
    print(f"{p.name}: {len(p.read_text())} chars, {len(p.read_bytes())} bytes")
PY
```

Expected: `07-long-many-sections.md` well over 2000 characters but under 30 000
bytes, and `08-big-file.md` over 30 000 bytes. If `07` lands above 30 000 bytes
it would take the big-file branch instead and defeat its purpose — reduce the
repeat count until it does not.

- [ ] **Step 3: Generate the golden file from the Python original**

Run this once. It imports the reference implementation and records its output.

```bash
python3 - <<'PY' > crates/cowork-memory/tests/fixtures/golden.json
import importlib.util, json, os, pathlib

path = os.path.expanduser("~/.claude/bin/vault_index.py")
spec = importlib.util.spec_from_file_location("vault_index", path)
vi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vi)

notes = sorted(pathlib.Path("crates/cowork-memory/tests/fixtures/notes").glob("*.md"))
out = {}
for p in notes:
    _project, chunks = vi.chunk_note(p.name, p.read_text())
    out[p.name] = chunks

print(json.dumps(out, ensure_ascii=False, indent=2))
PY
```

Sanity-check the result before trusting it:

```bash
python3 -c "
import json
d = json.load(open('crates/cowork-memory/tests/fixtures/golden.json'))
for k, v in d.items(): print(k, '->', len(v), 'chunks')
"
```

Expected, and each line is checking something specific:

| File | Chunks | Why |
|---|---|---|
| `03-noise-only.md` | 0 | Skeleton filtered by the letter minimum |
| `04-empty-tldr.md` | 1 | Empty TL;DR emits no chunk but still relaxes the threshold |
| `07-long-many-sections.md` | 3 or more | The section-splitting branch actually ran |
| `08-big-file.md` | 1 | Over `BIG_FILE`, only the TL;DR is indexed |
| everything else | 1 or 2 | |

If `07` reports 1 chunk, the fixture is too short and the riskiest branch is
still untested — enlarge it and regenerate.

- [ ] **Step 4: Write the failing golden test**

Create `crates/cowork-memory/tests/golden.rs`:

```rust
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Chunking must match the reference Python implementation exactly. The golden
/// file is generated by the snippet in the plan for this task.
#[test]
fn chunking_matches_the_python_reference() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let golden: BTreeMap<String, Vec<String>> =
        serde_json::from_str(&fs::read_to_string(root.join("golden.json")).unwrap()).unwrap();

    assert!(!golden.is_empty(), "golden fixture is empty");

    for (name, expected) in &golden {
        let text = fs::read_to_string(root.join("notes").join(name)).unwrap();
        let actual = cowork_memory::corpus::chunk_note(name, &text);

        assert_eq!(
            actual.len(),
            expected.len(),
            "{name}: chunk count differs\n  actual:   {actual:#?}\n  expected: {expected:#?}"
        );
        for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            assert_eq!(a, e, "{name}: chunk {i} differs");
        }
    }
}
```

Add `serde_json` to dev-dependencies in `crates/cowork-memory/Cargo.toml`:

```toml
[dev-dependencies]
serde_json = "1"
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml --test golden`
Expected: FAIL — `chunk_note` does not exist.

- [ ] **Step 6: Implement chunking**

Append to `crates/cowork-memory/src/corpus.rs`, above the test module:

```rust
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
    let tldr_matched = tldr.is_some();
    let tldr_content = tldr.as_deref().map(str::trim).filter(|t| !t.is_empty());

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
        // Faithful to Python: the match object being truthy is what counts,
        // even when the TL;DR body was empty and produced no chunk.
        let is_tldr = tldr_matched && idx == 0;
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
```

- [ ] **Step 7: Run the golden test**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml --test golden -- --nocapture`
Expected: PASS.

If it fails, the assertion prints both chunk lists. Check the character-versus-byte rule first — it is the most common cause.

- [ ] **Step 8: Add unit tests for the helpers**

Add to the `tests` module in `corpus.rs`:

```rust
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
```

- [ ] **Step 9: Run all tests**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml`
Expected: PASS, all tests.

- [ ] **Step 10: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): port vault-index chunking with golden parity tests"
```

---

### Task 4: Corpus scan and scope detection

**Files:**
- Create: `crates/cowork-memory/src/scan.rs`
- Modify: `crates/cowork-memory/src/lib.rs` (add `pub mod scan;`)

**Interfaces:**
- Consumes: `DIARY_SCOPE` from `lib.rs`.
- Produces:
  - `#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)] pub struct FileStat { pub mtime: f64, pub size: u64 }`
  - `pub struct Located { pub scope: String, pub room: Option<String> }`
  - `pub fn detect_scope(rel_path: &str) -> Option<Located>` — None for files outside the known layout.
  - `pub fn scan(root: &std::path::Path) -> std::collections::BTreeMap<String, FileStat>` — relative paths to stats, `.md` only.

The app knows the workspace, so the Python `detect_project` heuristics are replaced by pure layout rules:

| Relative path | Scope | Room |
|---|---|---|
| `Diaries/{room}/2026-07.md` | `__diaries__` | `Some("{room}")` |
| `{workspace_id}/Sessions/2026-07/27-topic.md` | `{workspace_id}` | None |
| `{workspace_id}/Facts.md` | `{workspace_id}` | None |
| anything starting with `.` | skipped | — |
| top-level `*.json` | skipped | — |

- [ ] **Step 1: Write the failing test**

Create `crates/cowork-memory/src/scan.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detects_scope_from_layout() {
        let d = detect_scope("Diaries/code-reviewer/2026-07.md").unwrap();
        assert_eq!(d.scope, crate::DIARY_SCOPE);
        assert_eq!(d.room.as_deref(), Some("code-reviewer"));

        let s = detect_scope("ws-42/Sessions/2026-07/27-topic.md").unwrap();
        assert_eq!(s.scope, "ws-42");
        assert_eq!(s.room, None);

        let f = detect_scope("ws-42/Facts.md").unwrap();
        assert_eq!(f.scope, "ws-42");

        assert!(detect_scope("Diaries/2026-07.md").is_none(), "diary needs a room");
        assert!(detect_scope("loose.md").is_none(), "top-level files have no scope");
    }

    #[test]
    fn scan_finds_markdown_and_skips_dotdirs_and_json() {
        let root = std::env::temp_dir().join(format!("cwm-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("ws-1/Sessions/2026-07")).unwrap();
        fs::create_dir_all(root.join(".index")).unwrap();
        fs::write(root.join("ws-1/Sessions/2026-07/27-a.md"), "# a\n").unwrap();
        fs::write(root.join("ws-1/Facts.md"), "# f\n").unwrap();
        fs::write(root.join("queue.json"), "[]").unwrap();
        fs::write(root.join(".index/meta.json"), "{}").unwrap();

        let files = scan(&root);
        let mut keys: Vec<_> = files.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["ws-1/Facts.md", "ws-1/Sessions/2026-07/27-a.md"]);
        assert!(files["ws-1/Facts.md"].size > 0);

        fs::remove_dir_all(&root).unwrap();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml scan`
Expected: FAIL — `cannot find function detect_scope`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `crates/cowork-memory/src/scan.rs`:

```rust
use crate::DIARY_SCOPE;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileStat {
    pub mtime: f64,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Located {
    pub scope: String,
    pub room: Option<String>,
}

/// Scope of a note from its position in the memory layout.
pub fn detect_scope(rel_path: &str) -> Option<Located> {
    let parts: Vec<&str> = rel_path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    if parts[0] == "Diaries" {
        if parts.len() < 3 {
            return None;
        }
        return Some(Located {
            scope: DIARY_SCOPE.to_string(),
            room: Some(parts[1].to_string()),
        });
    }
    Some(Located {
        scope: parts[0].to_string(),
        room: None,
    })
}

/// Every indexable `.md` file under `root`, keyed by slash-separated relative path.
pub fn scan(root: &Path) -> BTreeMap<String, FileStat> {
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, FileStat>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk(root, &path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if detect_scope(&rel).is_none() {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        out.insert(rel, FileStat { mtime, size: md.len() });
    }
}
```

Add to `crates/cowork-memory/src/lib.rs`:

```rust
pub mod scan;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml scan`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): corpus scan with layout-based scope detection"
```

---

### Task 5: Index store

**Files:**
- Create: `crates/cowork-memory/src/index.rs`
- Modify: `crates/cowork-memory/src/lib.rs` (add `pub mod index;`)

**Interfaces:**
- Consumes: `FileStat` from Task 4.
- Produces:
  - `#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)] pub struct ChunkRecord { pub file: String, pub scope: String, pub room: Option<String>, pub text: String }`
  - `#[derive(Default, Serialize, Deserialize)] pub struct Meta { pub files: BTreeMap<String, FileStat>, pub chunks: Vec<ChunkRecord>, pub dim: usize }`
  - `pub struct Index { pub meta: Meta, pub emb: Vec<f32> }` — `emb` is row-major, `meta.chunks.len() * meta.dim` floats.
  - `pub fn load(cache: &Path) -> Index` — a missing, corrupt or length-mismatched cache returns an empty index rather than failing.
  - `pub fn save(cache: &Path, ix: &Index) -> anyhow::Result<()>`

Vectors are stored as raw little-endian `f32` in `emb.bin`, not as JSON — 384 floats per chunk would otherwise dominate the file.

- [ ] **Step 1: Write the failing test**

Create `crates/cowork-memory/src/index.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("cwm-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample() -> Index {
        let mut meta = Meta { dim: 2, ..Default::default() };
        meta.files.insert(
            "ws-1/Facts.md".into(),
            crate::scan::FileStat { mtime: 1.0, size: 10 },
        );
        meta.chunks.push(ChunkRecord {
            file: "ws-1/Facts.md".into(),
            scope: "ws-1".into(),
            room: None,
            text: "нечто".into(),
        });
        Index { meta, emb: vec![0.6, 0.8] }
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tmp("rt");
        save(&dir, &sample()).unwrap();
        let back = load(&dir);
        assert_eq!(back.meta.chunks, sample().meta.chunks);
        assert_eq!(back.meta.files, sample().meta.files);
        assert_eq!(back.emb, vec![0.6, 0.8]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_cache_loads_empty() {
        let dir = tmp("missing");
        let ix = load(&dir);
        assert!(ix.meta.chunks.is_empty());
        assert!(ix.emb.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrupt_meta_loads_empty_instead_of_failing() {
        let dir = tmp("corrupt");
        save(&dir, &sample()).unwrap();
        fs::write(dir.join("meta.json"), "{ not json").unwrap();
        assert!(load(&dir).meta.chunks.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn length_mismatch_loads_empty_instead_of_returning_garbage() {
        let dir = tmp("mismatch");
        save(&dir, &sample()).unwrap();
        fs::write(dir.join("emb.bin"), [0u8; 4]).unwrap(); // 1 float, expected 2
        assert!(load(&dir).meta.chunks.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml index`
Expected: FAIL — `cannot find type Index`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `crates/cowork-memory/src/index.rs`:

```rust
use crate::scan::FileStat;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChunkRecord {
    pub file: String,
    pub scope: String,
    pub room: Option<String>,
    pub text: String,
}

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct Meta {
    pub files: BTreeMap<String, FileStat>,
    pub chunks: Vec<ChunkRecord>,
    pub dim: usize,
}

#[derive(Default, Debug)]
pub struct Index {
    pub meta: Meta,
    /// Row-major, `chunks.len() * dim` floats.
    pub emb: Vec<f32>,
}

/// Load the cache. Anything wrong with it yields an empty index, which the
/// caller rebuilds — the cache is disposable by design.
pub fn load(cache: &Path) -> Index {
    let Ok(raw) = std::fs::read_to_string(cache.join("meta.json")) else {
        return Index::default();
    };
    let Ok(meta) = serde_json::from_str::<Meta>(&raw) else {
        return Index::default();
    };
    let Ok(bytes) = std::fs::read(cache.join("emb.bin")) else {
        return Index::default();
    };
    if bytes.len() % 4 != 0 {
        return Index::default();
    }
    let emb: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if emb.len() != meta.chunks.len() * meta.dim {
        return Index::default();
    }
    Index { meta, emb }
}

pub fn save(cache: &Path, ix: &Index) -> Result<()> {
    std::fs::create_dir_all(cache)?;
    std::fs::write(cache.join("meta.json"), serde_json::to_vec(&ix.meta)?)?;
    let mut bytes = Vec::with_capacity(ix.emb.len() * 4);
    for f in &ix.emb {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    std::fs::write(cache.join("emb.bin"), bytes)?;
    Ok(())
}
```

Add to `crates/cowork-memory/src/lib.rs`:

```rust
pub mod index;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml index`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): index store with disposable-cache semantics"
```

---

### Task 6: Incremental update

**Files:**
- Modify: `crates/cowork-memory/src/index.rs`

**Interfaces:**
- Consumes: `scan::scan`, `scan::detect_scope`, `corpus::chunk_note`, `embed::Embedder`, `load`, `save`.
- Produces:
  - `pub struct UpdateReport { pub files: usize, pub chunks: usize, pub changed: usize }`
  - `pub fn update(root: &Path, cache: &Path, emb: &dyn Embedder) -> anyhow::Result<(Index, UpdateReport)>`

Ported from `update()` in `vault_index.py`: keep the rows of unchanged files, re-chunk and re-embed changed ones, drop deleted ones, and embed in batches.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `index.rs`:

```rust
#[test]
fn update_indexes_then_reuses_then_notices_change() {
    use crate::embed::{Embedder, FakeEmbedder};
    let dir = tmp("update");
    let root = dir.join("memory");
    let cache = dir.join("cache");
    fs::create_dir_all(root.join("ws-1")).unwrap();

    let long = "Достаточно длинный текст для прохождения фильтра шума. ".repeat(5);
    fs::write(root.join("ws-1/Facts.md"), format!("# Факты\n\n{long}")).unwrap();

    let e = FakeEmbedder::new();

    let (ix, rep) = update(&root, &cache, &e).unwrap();
    assert_eq!(rep.files, 1);
    assert_eq!(rep.changed, 1);
    assert!(rep.chunks >= 1, "expected at least one chunk");
    assert_eq!(ix.emb.len(), ix.meta.chunks.len() * e.dim());
    assert_eq!(ix.meta.chunks[0].scope, "ws-1");

    let (_ix, rep) = update(&root, &cache, &e).unwrap();
    assert_eq!(rep.changed, 0, "unchanged corpus must not re-embed");

    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(root.join("ws-1/Facts.md"), format!("# Факты\n\n{long} и ещё немного.")).unwrap();
    let (_ix, rep) = update(&root, &cache, &e).unwrap();
    assert_eq!(rep.changed, 1, "edited file must be re-indexed");

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn update_drops_chunks_of_deleted_files() {
    use crate::embed::{Embedder, FakeEmbedder};
    let dir = tmp("delete");
    let root = dir.join("memory");
    let cache = dir.join("cache");
    fs::create_dir_all(root.join("ws-1")).unwrap();

    let long = "Достаточно длинный текст для прохождения фильтра шума. ".repeat(5);
    fs::write(root.join("ws-1/Facts.md"), format!("# Факты\n\n{long}")).unwrap();
    fs::write(root.join("ws-1/Other.md"), format!("# Другое\n\n{long}")).unwrap();

    let e = FakeEmbedder::new();
    let (ix, _) = update(&root, &cache, &e).unwrap();
    let before = ix.meta.chunks.len();

    fs::remove_file(root.join("ws-1/Other.md")).unwrap();
    let (ix, rep) = update(&root, &cache, &e).unwrap();
    assert_eq!(rep.changed, 1);
    assert!(ix.meta.chunks.len() < before, "deleted file's chunks must go");
    assert!(ix.meta.chunks.iter().all(|c| c.file != "ws-1/Other.md"));
    assert_eq!(ix.emb.len(), ix.meta.chunks.len() * e.dim());

    fs::remove_dir_all(&dir).unwrap();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml index::tests::update`
Expected: FAIL — `cannot find function update`.

- [ ] **Step 3: Write minimal implementation**

Append to `crates/cowork-memory/src/index.rs`, above the test module:

```rust
use crate::corpus::chunk_note;
use crate::embed::Embedder;
use crate::scan::{detect_scope, scan};

pub struct UpdateReport {
    pub files: usize,
    pub chunks: usize,
    pub changed: usize,
}

/// Incremental reindex: unchanged files keep their rows, changed files are
/// re-chunked and re-embedded, deleted files lose theirs.
pub fn update(root: &Path, cache: &Path, emb: &dyn Embedder) -> Result<(Index, UpdateReport)> {
    let old = load(cache);
    let current = scan(root);

    let changed: Vec<String> = current
        .iter()
        .filter(|(f, s)| old.meta.files.get(*f) != Some(s))
        .map(|(f, _)| f.clone())
        .collect();
    let deleted: usize = old
        .meta
        .files
        .keys()
        .filter(|f| !current.contains_key(*f))
        .count();

    if changed.is_empty() && deleted == 0 {
        let report = UpdateReport {
            files: old.meta.files.len(),
            chunks: old.meta.chunks.len(),
            changed: 0,
        };
        return Ok((old, report));
    }

    let dim = emb.dim();
    let mut chunks: Vec<ChunkRecord> = Vec::new();
    let mut rows: Vec<f32> = Vec::new();

    // Keep rows whose file is still present and unmodified.
    if old.meta.dim == dim {
        for (i, c) in old.meta.chunks.iter().enumerate() {
            let unchanged = current
                .get(&c.file)
                .is_some_and(|s| old.meta.files.get(&c.file) == Some(s));
            if unchanged {
                chunks.push(c.clone());
                rows.extend_from_slice(&old.emb[i * dim..(i + 1) * dim]);
            }
        }
    }

    let mut fresh: Vec<ChunkRecord> = Vec::new();
    for f in &changed {
        let Ok(text) = std::fs::read_to_string(root.join(f)) else {
            continue;
        };
        let Some(loc) = detect_scope(f) else { continue };
        for t in chunk_note(f, &text) {
            fresh.push(ChunkRecord {
                file: f.clone(),
                scope: loc.scope.clone(),
                room: loc.room.clone(),
                text: t,
            });
        }
    }

    for batch in fresh.chunks(16) {
        let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
        for v in emb.embed(&texts)? {
            rows.extend_from_slice(&v);
        }
    }
    chunks.extend(fresh);

    let ix = Index {
        meta: Meta { files: current, chunks, dim },
        emb: rows,
    };
    save(cache, &ix)?;

    let report = UpdateReport {
        files: ix.meta.files.len(),
        chunks: ix.meta.chunks.len(),
        changed: changed.len() + deleted,
    };
    Ok((ix, report))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml index`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): incremental index update"
```

---

### Task 7: Cosine search

**Files:**
- Modify: `crates/cowork-memory/src/index.rs`

**Interfaces:**
- Consumes: `Index`, `Embedder`.
- Produces:
  - `#[derive(Debug, Clone, Serialize)] pub struct Hit { pub score: f32, pub file: String, pub scope: String, pub room: Option<String>, pub text: String }`
  - `pub enum SearchScope { Project(String), Lessons, All }`
  - `pub fn search(ix: &Index, emb: &dyn Embedder, query: &str, scope: &SearchScope, top: usize, min_score: f32) -> anyhow::Result<Vec<Hit>>`

Ported from `search_hits`: score by dot product (vectors are unit length), walk in descending order, stop below `min_score`, and emit **at most one hit per file**. A `Project(id)` search also matches diary chunks — that union is what makes lessons cross-project.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `index.rs`:

```rust
#[test]
fn search_respects_scope_dedupes_by_file_and_honours_threshold() {
    use crate::embed::{Embedder, FakeEmbedder};
    let e = FakeEmbedder::new();
    let dim = e.dim();

    let mut meta = Meta { dim, ..Default::default() };
    for (file, scope, room, text) in [
        ("ws-1/Facts.md", "ws-1", None, "первый чанк файла ws-1"),
        ("ws-1/Facts.md", "ws-1", None, "второй чанк того же файла"),
        ("ws-2/Facts.md", "ws-2", None, "чанк чужого воркспейса"),
        ("Diaries/reviewer/2026-07.md", crate::DIARY_SCOPE, Some("reviewer"), "урок ревьюера"),
    ] {
        meta.chunks.push(ChunkRecord {
            file: file.into(),
            scope: scope.into(),
            room: room.map(str::to_string),
            text: text.into(),
        });
    }
    let texts: Vec<String> = meta.chunks.iter().map(|c| c.text.clone()).collect();
    let emb: Vec<f32> = e.embed(&texts).unwrap().into_iter().flatten().collect();
    let ix = Index { meta, emb };

    let hits = search(&ix, &e, "любой запрос", &SearchScope::Project("ws-1".into()), 10, -1.0).unwrap();
    let files: Vec<&str> = hits.iter().map(|h| h.file.as_str()).collect();
    assert!(files.contains(&"ws-1/Facts.md"), "own workspace must match");
    assert!(files.contains(&"Diaries/reviewer/2026-07.md"), "diaries are always in scope");
    assert!(!files.contains(&"ws-2/Facts.md"), "other workspaces must not match");
    assert_eq!(files.len(), 2, "one hit per file, got {files:?}");

    let lessons = search(&ix, &e, "любой запрос", &SearchScope::Lessons, 10, -1.0).unwrap();
    assert_eq!(lessons.len(), 1);
    assert_eq!(lessons[0].room.as_deref(), Some("reviewer"));

    let all = search(&ix, &e, "любой запрос", &SearchScope::All, 10, -1.0).unwrap();
    assert_eq!(all.len(), 3, "three distinct files");

    let capped = search(&ix, &e, "любой запрос", &SearchScope::All, 1, -1.0).unwrap();
    assert_eq!(capped.len(), 1, "top must cap results");

    let none = search(&ix, &e, "любой запрос", &SearchScope::All, 10, 1.01).unwrap();
    assert!(none.is_empty(), "nothing scores above 1.01");
}

#[test]
fn search_returns_hits_in_descending_score_order() {
    use crate::embed::{Embedder, FakeEmbedder};
    let e = FakeEmbedder::new();
    let dim = e.dim();
    let mut meta = Meta { dim, ..Default::default() };
    for i in 0..8 {
        meta.chunks.push(ChunkRecord {
            file: format!("ws-1/n{i}.md"),
            scope: "ws-1".into(),
            room: None,
            text: format!("чанк номер {i}"),
        });
    }
    let texts: Vec<String> = meta.chunks.iter().map(|c| c.text.clone()).collect();
    let emb: Vec<f32> = e.embed(&texts).unwrap().into_iter().flatten().collect();
    let ix = Index { meta, emb };

    let hits = search(&ix, &e, "чанк номер 3", &SearchScope::All, 8, -1.0).unwrap();
    for w in hits.windows(2) {
        assert!(w[0].score >= w[1].score, "not sorted: {:?}", hits);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml index::tests::search`
Expected: FAIL — `cannot find function search`.

- [ ] **Step 3: Write minimal implementation**

Append to `crates/cowork-memory/src/index.rs`, above the test module:

```rust
use crate::DIARY_SCOPE;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub score: f32,
    pub file: String,
    pub scope: String,
    pub room: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub enum SearchScope {
    /// This workspace plus the global diaries.
    Project(String),
    /// Global diaries only.
    Lessons,
    /// Everything.
    All,
}

impl SearchScope {
    fn admits(&self, c: &ChunkRecord) -> bool {
        match self {
            SearchScope::All => true,
            SearchScope::Lessons => c.scope == DIARY_SCOPE,
            SearchScope::Project(id) => c.scope == *id || c.scope == DIARY_SCOPE,
        }
    }
}

/// Brute-force cosine over unit vectors, at most one hit per file.
pub fn search(
    ix: &Index,
    emb: &dyn Embedder,
    query: &str,
    scope: &SearchScope,
    top: usize,
    min_score: f32,
) -> Result<Vec<Hit>> {
    if ix.meta.chunks.is_empty() || ix.meta.dim == 0 {
        return Ok(Vec::new());
    }
    let dim = ix.meta.dim;
    let q = emb.embed(&[query.to_string()])?.remove(0);
    if q.len() != dim {
        anyhow::bail!(
            "embedder dimension {} does not match index dimension {dim}; reindex is required",
            q.len()
        );
    }

    let mut scored: Vec<(f32, usize)> = (0..ix.meta.chunks.len())
        .map(|i| {
            let row = &ix.emb[i * dim..(i + 1) * dim];
            let s: f32 = row.iter().zip(q.iter()).map(|(a, b)| a * b).sum();
            (s, i)
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut hits = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for (score, i) in scored {
        if score < min_score {
            break;
        }
        let c = &ix.meta.chunks[i];
        if !scope.admits(c) || !seen.insert(&c.file) {
            continue;
        }
        hits.push(Hit {
            score,
            file: c.file.clone(),
            scope: c.scope.clone(),
            room: c.room.clone(),
            text: c.text.clone(),
        });
        if hits.len() >= top {
            break;
        }
    }
    Ok(hits)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml index`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): cosine search with scope filtering and per-file dedup"
```

---

### Task 8: CLI — `update`, `search`, `status`

**Files:**
- Modify: `crates/cowork-memory/src/main.rs`
- Create: `crates/cowork-memory/tests/cli.rs`

**Interfaces:**
- Consumes: everything from Tasks 4–7.
- Produces: the binary contract that the app depends on in phases 2 and 3.

```
cowork_memory --root <dir> [--cache <dir>] update [--verbose]
cowork_memory --root <dir> [--cache <dir>] search <query> [--scope <ws-id>|lessons|all] [--top N] [--min-score F] [--json]
cowork_memory --root <dir> [--cache <dir>] status [--json]
```

`--cache` defaults to `<root>/.index`. `COWORK_MEMORY_FAKE_EMBED=1` selects `FakeEmbedder` — the mechanism the Python tool exposes as `VAULT_INDEX_FAKE_EMBED`, and the reason the CLI is testable without a 470 MB download. `search` updates the index first, as the Python `search` does. `--json` exists because phases 2 and 3 parse this output.

- [ ] **Step 1: Write the failing test**

Create `crates/cowork-memory/tests/cli.rs`:

```rust
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn fixture_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("cwm-cli-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("ws-1/Sessions/2026-07")).unwrap();
    fs::create_dir_all(root.join("Diaries/reviewer")).unwrap();

    let body = "Планировщик живёт внутри приложения и догоняет пропущенные запуски \
                при следующем старте, поэтому облачные раннеры не нужны вовсе. ";
    fs::write(
        root.join("ws-1/Sessions/2026-07/27-scheduler.md"),
        format!("# Планировщик\n\n## TL;DR\n{}\n", body.repeat(2)),
    )
    .unwrap();
    fs::write(
        root.join("Diaries/reviewer/2026-07.md"),
        format!("# Уроки ревьюера\n\n{}\n", body.repeat(2)),
    )
    .unwrap();
    root
}

fn run(root: &PathBuf, args: &[&str]) -> (String, String, bool) {
    let out = Command::new(env!("CARGO_BIN_EXE_cowork_memory"))
        .env("COWORK_MEMORY_FAKE_EMBED", "1")
        .arg("--root")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.success(),
    )
}

#[test]
fn update_then_status_reports_the_corpus() {
    let root = fixture_root("update");

    let (stdout, stderr, ok) = run(&root, &["update"]);
    assert!(ok, "update failed: {stderr}");
    assert!(stdout.contains("2 files"), "got: {stdout}");

    let (stdout, stderr, ok) = run(&root, &["status", "--json"]);
    assert!(ok, "status failed: {stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["files"], 2);
    assert!(v["chunks"].as_u64().unwrap() >= 2, "got: {stdout}");
    assert_eq!(v["dim"], 64, "fake embedder dim");

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn search_scoped_to_a_workspace_also_returns_diaries() {
    let root = fixture_root("search");

    let (stdout, stderr, ok) = run(
        &root,
        &["search", "планировщик", "--scope", "ws-1", "--min-score", "-1", "--json"],
    );
    assert!(ok, "search failed: {stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    let hits = v.as_array().unwrap();
    let files: Vec<&str> = hits.iter().map(|h| h["file"].as_str().unwrap()).collect();
    assert!(files.iter().any(|f| f.starts_with("ws-1/")), "got: {files:?}");
    assert!(files.iter().any(|f| f.starts_with("Diaries/")), "got: {files:?}");

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn search_updates_the_index_before_querying() {
    let root = fixture_root("autoupdate");
    // No explicit `update` call: search must build the index itself.
    let (stdout, stderr, ok) = run(&root, &["search", "запрос", "--min-score", "-1", "--json"]);
    assert!(ok, "search failed: {stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert!(!v.as_array().unwrap().is_empty(), "expected hits, got: {stdout}");
    assert!(root.join(".index/meta.json").exists(), "index was not written");

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn no_results_is_success_with_an_explanatory_stderr_line() {
    let root = fixture_root("empty");
    let (stdout, stderr, ok) = run(&root, &["search", "запрос", "--min-score", "1.01"]);
    assert!(ok, "no results must not be an error");
    assert!(stdout.trim().is_empty(), "got: {stdout}");
    assert!(stderr.contains("no results"), "got: {stderr}");

    fs::remove_dir_all(&root).unwrap();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml --test cli`
Expected: FAIL — the binary prints `cowork_memory` and ignores its arguments.

- [ ] **Step 3: Write minimal implementation**

Replace `crates/cowork-memory/src/main.rs`:

```rust
use anyhow::Result;
use clap::{Parser, Subcommand};
use cowork_memory::embed::{Embedder, FakeEmbedder};
use cowork_memory::index::{search, update, SearchScope};
use cowork_memory::SNIPPET;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "cowork_memory", about = "Semantic memory for cowork-deck")]
struct Cli {
    /// Corpus root, the memory directory.
    #[arg(long)]
    root: PathBuf,
    /// Index cache. Defaults to <root>/.index
    #[arg(long)]
    cache: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Incrementally reindex the corpus.
    Update {
        #[arg(long)]
        verbose: bool,
    },
    /// Semantic search. Updates the index first.
    Search {
        query: String,
        /// A workspace id, or "lessons", or "all".
        #[arg(long, default_value = "all")]
        scope: String,
        #[arg(long, default_value_t = 10)]
        top: usize,
        #[arg(long, default_value_t = 0.25)]
        min_score: f32,
        #[arg(long)]
        json: bool,
    },
    /// Index statistics.
    Status {
        #[arg(long)]
        json: bool,
    },
}

fn embedder() -> Result<Box<dyn Embedder>> {
    if std::env::var("COWORK_MEMORY_FAKE_EMBED").is_ok() {
        return Ok(Box::new(FakeEmbedder::new()));
    }
    anyhow::bail!("no embedding model available yet — see `cowork_memory model --download`")
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cache = cli.cache.clone().unwrap_or_else(|| cli.root.join(".index"));

    match cli.cmd {
        Cmd::Update { verbose } => {
            let e = embedder()?;
            let (_ix, rep) = update(&cli.root, &cache, e.as_ref())?;
            if verbose {
                eprintln!("root: {}", cli.root.display());
                eprintln!("cache: {}", cache.display());
            }
            println!(
                "indexed {} files, {} chunks ({} files changed)",
                rep.files, rep.chunks, rep.changed
            );
        }
        Cmd::Status { json } => {
            let ix = cowork_memory::index::load(&cache);
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "root": cli.root.display().to_string(),
                        "cache": cache.display().to_string(),
                        "files": ix.meta.files.len(),
                        "chunks": ix.meta.chunks.len(),
                        "dim": ix.meta.dim,
                    })
                );
            } else {
                println!("root:   {}", cli.root.display());
                println!("cache:  {}", cache.display());
                println!("files:  {}", ix.meta.files.len());
                println!("chunks: {} (dim {})", ix.meta.chunks.len(), ix.meta.dim);
            }
        }
        Cmd::Search { query, scope, top, min_score, json } => {
            let e = embedder()?;
            let (ix, _) = update(&cli.root, &cache, e.as_ref())?;
            let scope = match scope.as_str() {
                "all" => SearchScope::All,
                "lessons" => SearchScope::Lessons,
                other => SearchScope::Project(other.to_string()),
            };
            let hits = search(&ix, e.as_ref(), &query, &scope, top, min_score)?;
            if json {
                println!("{}", serde_json::to_string(&hits)?);
            } else {
                for h in &hits {
                    let room = h.room.as_deref().map(|r| format!(" ({r})")).unwrap_or_default();
                    println!("[{:.2}] {}{}", h.score, h.file, room);
                    let flat: String = h.text.split_whitespace().collect::<Vec<_>>().join(" ");
                    println!("    {}", flat.chars().take(SNIPPET).collect::<String>());
                }
                if hits.is_empty() {
                    eprintln!("cowork_memory: no results above threshold");
                }
            }
            if json && hits.is_empty() {
                eprintln!("cowork_memory: no results above threshold");
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml --test cli`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): cowork_memory CLI with update, search and status"
```

---

### Task 9: Model download with resume and verification

**Files:**
- Create: `crates/cowork-memory/src/model.rs`
- Modify: `crates/cowork-memory/src/lib.rs` (add `pub mod model;`)
- Modify: `crates/cowork-memory/Cargo.toml` (add `ureq`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub struct ModelFile { pub url: String, pub name: &'static str, pub expected: u64 }`
  - `pub fn files() -> Vec<ModelFile>` — the two files with their exact expected sizes.
  - `pub trait Fetcher { fn fetch(&self, url: &str, from: u64) -> anyhow::Result<Box<dyn std::io::Read>>; }`
  - `pub struct HttpFetcher;`
  - `pub fn download_one(dir: &Path, f: &ModelFile, fetch: &dyn Fetcher, progress: &mut dyn FnMut(u64, u64)) -> anyhow::Result<PathBuf>`
  - `pub fn is_present(dir: &Path) -> bool` — both files exist at their exact expected size.

Downloads land in `<name>.part` and are renamed only once the byte count matches exactly, so a file that looks complete is complete. `Fetcher` is a trait so the tests exercise resume and truncation without touching the network.

- [ ] **Step 1: Write the failing test**

Create `crates/cowork-memory/src/model.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;

    struct CannedFetcher {
        body: Vec<u8>,
        /// Serve at most this many bytes per call, to simulate a dropped connection.
        limit: usize,
    }

    impl Fetcher for CannedFetcher {
        fn fetch(&self, _url: &str, from: u64) -> anyhow::Result<Box<dyn std::io::Read>> {
            let start = from as usize;
            let end = (start + self.limit).min(self.body.len());
            Ok(Box::new(Cursor::new(self.body[start..end].to_vec())))
        }
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("cwm-model-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn expected_sizes_are_the_published_ones() {
        let f = files();
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].name, "model.onnx");
        assert_eq!(f[0].expected, 470_301_610);
        assert_eq!(f[1].name, "tokenizer.json");
        assert_eq!(f[1].expected, 9_081_518);
    }

    #[test]
    fn resumes_a_partial_download_and_renames_atomically() {
        let dir = tmp("resume");
        let body: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let file = ModelFile { url: "x".into(), name: "model.onnx", expected: 1000 };
        // 300 bytes per call, so it takes four calls.
        let fetcher = CannedFetcher { body: body.clone(), limit: 300 };

        let mut seen: Vec<(u64, u64)> = Vec::new();
        let path = download_one(&dir, &file, &fetcher, &mut |got, total| seen.push((got, total))).unwrap();

        assert_eq!(fs::read(&path).unwrap(), body, "content must be exact");
        assert!(!dir.join("model.onnx.part").exists(), "part file must be gone");
        assert!(seen.len() > 1, "progress must be reported more than once");
        assert_eq!(seen.last().unwrap(), &(1000, 1000));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_to_finish_when_the_source_is_short() {
        let dir = tmp("short");
        let body: Vec<u8> = vec![7u8; 500];
        let file = ModelFile { url: "x".into(), name: "model.onnx", expected: 1000 };
        let fetcher = CannedFetcher { body, limit: 500 };

        let err = download_one(&dir, &file, &fetcher, &mut |_, _| {}).unwrap_err();
        assert!(err.to_string().contains("stalled"), "got: {err}");
        assert!(!dir.join("model.onnx").exists(), "must not publish a short file");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn is_present_requires_both_files_at_exact_size() {
        let dir = tmp("present");
        assert!(!is_present(&dir));
        fs::write(dir.join("model.onnx"), vec![0u8; 10]).unwrap();
        fs::write(dir.join("tokenizer.json"), vec![0u8; 10]).unwrap();
        assert!(!is_present(&dir), "wrong sizes must not count as present");
        fs::remove_dir_all(&dir).unwrap();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml model`
Expected: FAIL — `cannot find function files`.

- [ ] **Step 3: Write minimal implementation**

Add to `crates/cowork-memory/Cargo.toml` dependencies:

```toml
ureq = "2"
```

Prepend to `crates/cowork-memory/src/model.rs`:

```rust
use anyhow::{bail, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const BASE: &str =
    "https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/main";

pub struct ModelFile {
    pub url: String,
    pub name: &'static str,
    pub expected: u64,
}

/// The two files the embedder needs, with the sizes published by the host.
pub fn files() -> Vec<ModelFile> {
    vec![
        ModelFile {
            url: format!("{BASE}/onnx/model.onnx"),
            name: "model.onnx",
            expected: 470_301_610,
        },
        ModelFile {
            url: format!("{BASE}/tokenizer.json"),
            name: "tokenizer.json",
            expected: 9_081_518,
        },
    ]
}

/// Byte source, abstracted so tests can exercise resume without the network.
pub trait Fetcher {
    /// A reader starting at byte `from`.
    fn fetch(&self, url: &str, from: u64) -> Result<Box<dyn Read>>;
}

pub struct HttpFetcher;

impl Fetcher for HttpFetcher {
    fn fetch(&self, url: &str, from: u64) -> Result<Box<dyn Read>> {
        let req = ureq::get(url);
        let req = if from > 0 {
            req.set("Range", &format!("bytes={from}-"))
        } else {
            req
        };
        Ok(Box::new(req.call()?.into_reader()))
    }
}

/// True when both files are on disk at exactly their expected size.
pub fn is_present(dir: &Path) -> bool {
    files().iter().all(|f| {
        std::fs::metadata(dir.join(f.name))
            .map(|m| m.len() == f.expected)
            .unwrap_or(false)
    })
}

/// Download one file, resuming into `<name>.part` and renaming only once the
/// byte count matches exactly.
pub fn download_one(
    dir: &Path,
    f: &ModelFile,
    fetch: &dyn Fetcher,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let final_path = dir.join(f.name);
    if std::fs::metadata(&final_path).map(|m| m.len() == f.expected).unwrap_or(false) {
        progress(f.expected, f.expected);
        return Ok(final_path);
    }

    let part = dir.join(format!("{}.part", f.name));
    loop {
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if have >= f.expected {
            break;
        }

        let mut reader = fetch.fetch(&f.url, have)?;
        let mut sink = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part)?;

        let mut buf = vec![0u8; 64 * 1024];
        let mut written = 0u64;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            sink.write_all(&buf[..n])?;
            written += n as u64;
            progress(have + written, f.expected);
        }
        sink.flush()?;

        if written == 0 {
            bail!(
                "download of {} stalled at {} of {} bytes",
                f.name,
                have,
                f.expected
            );
        }
    }

    let got = std::fs::metadata(&part)?.len();
    if got != f.expected {
        bail!("{} is {got} bytes, expected {}", f.name, f.expected);
    }
    std::fs::rename(&part, &final_path)?;
    progress(f.expected, f.expected);
    Ok(final_path)
}
```

Add to `crates/cowork-memory/src/lib.rs`:

```rust
pub mod model;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml model`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/cowork-memory
git commit -m "feat(memory): model download with range resume and exact-size verification"
```

---

### Task 10: `OnnxEmbedder`, the `model` subcommand, staging and docs

**Files:**
- Create: `crates/cowork-memory/src/onnx.rs`
- Modify: `crates/cowork-memory/src/lib.rs`, `src/main.rs`, `Cargo.toml`
- Create: `scripts/stage-memory.sh`
- Modify: `package.json` (add `stage:memory`)
- Modify: `README.md`

**Interfaces:**
- Consumes: `Embedder` (Task 1), `model::{files, is_present, download_one, HttpFetcher}` (Task 9).
- Produces:
  - `pub struct OnnxEmbedder` with `pub fn load(dir: &Path) -> anyhow::Result<OnnxEmbedder>` — loads the model, then verifies it by embedding a probe string and checking the result is a finite unit vector of dim 384.
  - CLI: `cowork_memory --root <dir> model --download` and `model --status`.

Mean-pooling over the attention mask followed by L2 normalisation, batch 16, truncation 256 — the same arithmetic as the Python `OnnxEmbedder`. The `tokenizers` crate is the same library the Python `tokenizers` package binds to, so tokenisation matches by construction.

- [ ] **Step 1: Write the failing test**

Create `crates/cowork-memory/src/onnx.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_fails_clearly_when_the_model_is_absent() {
        let dir = std::env::temp_dir().join(format!("cwm-onnx-absent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let err = OnnxEmbedder::load(&dir).unwrap_err().to_string();
        assert!(err.contains("model"), "unhelpful error: {err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Only runs where the model has actually been downloaded. Guarded so the
    /// suite stays fast and offline by default.
    #[test]
    fn embeds_real_text_when_the_model_is_present() {
        let Ok(dir) = std::env::var("COWORK_MEMORY_MODEL_DIR") else {
            eprintln!("skipping: COWORK_MEMORY_MODEL_DIR not set");
            return;
        };
        let e = OnnxEmbedder::load(std::path::Path::new(&dir)).unwrap();
        assert_eq!(e.dim(), 384);

        let v = e
            .embed(&["привет мир".to_string(), "hello world".to_string()])
            .unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].len(), 384);
        let norm: f32 = v[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "not unit length: {norm}");

        // Multilingual: the same sentence across languages must be closer than
        // two unrelated sentences.
        let t = vec![
            "как починить сборку".to_string(),
            "how to fix the build".to_string(),
            "рецепт борща".to_string(),
        ];
        let m = e.embed(&t).unwrap();
        let dot = |a: &Vec<f32>, b: &Vec<f32>| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
        assert!(
            dot(&m[0], &m[1]) > dot(&m[0], &m[2]),
            "cross-language similarity failed: {} vs {}",
            dot(&m[0], &m[1]),
            dot(&m[0], &m[2])
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml onnx`
Expected: FAIL — `cannot find type OnnxEmbedder`.

- [ ] **Step 3: Write minimal implementation**

Add to `crates/cowork-memory/Cargo.toml` dependencies:

```toml
ort = "2.0.0-rc.10"
ndarray = "0.16"
tokenizers = { version = "0.20", default-features = false, features = ["onig"] }
```

Prepend to `crates/cowork-memory/src/onnx.rs`:

```rust
use crate::embed::Embedder;
use anyhow::{bail, Context, Result};
use ndarray::Array2;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::TensorRef;
use std::path::Path;
use tokenizers::Tokenizer;

pub struct OnnxEmbedder {
    session: Session,
    tokenizer: Tokenizer,
    has_token_type_ids: bool,
    dim: usize,
}

impl OnnxEmbedder {
    /// Load the model and prove it works by embedding a probe string. No
    /// checksum is published for these files, so a successful forward pass
    /// producing a finite unit vector is the verification.
    pub fn load(dir: &Path) -> Result<OnnxEmbedder> {
        let model_path = dir.join("model.onnx");
        let tok_path = dir.join("tokenizer.json");
        if !model_path.exists() || !tok_path.exists() {
            bail!(
                "embedding model not found in {} — run `cowork_memory model --download`",
                dir.display()
            );
        }

        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level1)?
            .commit_from_file(&model_path)
            .with_context(|| format!("failed to load {}", model_path.display()))?;

        let mut tokenizer = Tokenizer::from_file(&tok_path)
            .map_err(|e| anyhow::anyhow!("failed to load tokenizer: {e}"))?;
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: 256,
                ..Default::default()
            }))
            .map_err(|e| anyhow::anyhow!("truncation: {e}"))?;
        tokenizer.with_padding(Some(tokenizers::PaddingParams::default()));

        let has_token_type_ids = session
            .inputs
            .iter()
            .any(|i| i.name == "token_type_ids");

        let e = OnnxEmbedder { session, tokenizer, has_token_type_ids, dim: 0 };
        let probe = e.forward(&["проверка".to_string()])?;
        let v = &probe[0];
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if v.is_empty() || !v.iter().all(|x| x.is_finite()) || (norm - 1.0).abs() > 1e-2 {
            bail!("model loaded but produced an invalid probe vector — the file is likely corrupt");
        }
        let dim = v.len();
        Ok(OnnxEmbedder { dim, ..e })
    }

    fn forward(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| anyhow::anyhow!("tokenise: {e}"))?;

        let batch = encodings.len();
        let seq = encodings.first().map(|e| e.get_ids().len()).unwrap_or(0);
        if batch == 0 || seq == 0 {
            return Ok(vec![Vec::new(); batch]);
        }

        let ids: Vec<i64> = encodings
            .iter()
            .flat_map(|e| e.get_ids().iter().map(|&i| i as i64))
            .collect();
        let mask: Vec<i64> = encodings
            .iter()
            .flat_map(|e| e.get_attention_mask().iter().map(|&i| i as i64))
            .collect();

        let ids = Array2::from_shape_vec((batch, seq), ids)?;
        let mask_arr = Array2::from_shape_vec((batch, seq), mask.clone())?;

        let mut inputs = ort::inputs![
            "input_ids" => TensorRef::from_array_view(&ids)?,
            "attention_mask" => TensorRef::from_array_view(&mask_arr)?,
        ];
        let zeros = Array2::<i64>::zeros((batch, seq));
        if self.has_token_type_ids {
            inputs.push((
                "token_type_ids".into(),
                TensorRef::from_array_view(&zeros)?.into(),
            ));
        }

        let outputs = self.session.run(inputs)?;
        let (shape, hidden) = outputs[0].try_extract_tensor::<f32>()?;
        let hdim = shape[2] as usize;

        // Mean-pool over the attention mask, then L2-normalise.
        let mut out = Vec::with_capacity(batch);
        for b in 0..batch {
            let mut acc = vec![0f32; hdim];
            let mut n = 0f32;
            for t in 0..seq {
                let m = mask[b * seq + t] as f32;
                if m == 0.0 {
                    continue;
                }
                n += m;
                let base = (b * seq + t) * hdim;
                for (k, a) in acc.iter_mut().enumerate() {
                    *a += hidden[base + k] * m;
                }
            }
            let n = n.max(1e-9);
            for a in acc.iter_mut() {
                *a /= n;
            }
            let norm = acc.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
            for a in acc.iter_mut() {
                *a /= norm;
            }
            out.push(acc);
        }
        Ok(out)
    }
}

impl Embedder for OnnxEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for batch in texts.chunks(16) {
            out.extend(self.forward(batch)?);
        }
        Ok(out)
    }
}
```

Add to `crates/cowork-memory/src/lib.rs`:

```rust
pub mod onnx;
```

> **If the `ort` 2.x API has drifted:** consult `https://docs.rs/ort` for the current `Session`, `inputs!` and `try_extract_tensor` signatures and adjust. The arithmetic — mean-pool over the mask, L2-normalise, batch 16, truncate at 256 — is what must not change.

- [ ] **Step 4: Wire the `model` subcommand and the real embedder**

In `crates/cowork-memory/src/main.rs`, add the variant to `enum Cmd`:

```rust
    /// Download or inspect the embedding model.
    Model {
        #[arg(long)]
        download: bool,
        #[arg(long)]
        status: bool,
    },
```

Replace `fn embedder()` with a version that takes the model directory:

```rust
fn model_dir(root: &std::path::Path) -> PathBuf {
    std::env::var("COWORK_MEMORY_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join(".model"))
}

fn embedder(root: &std::path::Path) -> Result<Box<dyn Embedder>> {
    if std::env::var("COWORK_MEMORY_FAKE_EMBED").is_ok() {
        return Ok(Box::new(FakeEmbedder::new()));
    }
    Ok(Box::new(cowork_memory::onnx::OnnxEmbedder::load(&model_dir(root))?))
}
```

Update the three `embedder()` call sites to `embedder(&cli.root)?`, and add the match arm:

```rust
        Cmd::Model { download, status } => {
            let dir = model_dir(&cli.root);
            if download {
                for f in cowork_memory::model::files() {
                    let mut last = 0u64;
                    cowork_memory::model::download_one(
                        &dir,
                        &f,
                        &cowork_memory::model::HttpFetcher,
                        &mut |got, total| {
                            // One line per megabyte, so callers can parse progress.
                            if got == total || got - last >= 1_000_000 {
                                last = got;
                                println!(
                                    "{}",
                                    serde_json::json!({
                                        "file": f.name, "got": got, "total": total
                                    })
                                );
                            }
                        },
                    )?;
                }
            }
            if status || !download {
                println!(
                    "{}",
                    serde_json::json!({
                        "dir": dir.display().to_string(),
                        "present": cowork_memory::model::is_present(&dir),
                    })
                );
            }
        }
```

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path crates/cowork-memory/Cargo.toml`
Expected: PASS. The real-model test prints a skip line unless `COWORK_MEMORY_MODEL_DIR` is set.

- [ ] **Step 6: Verify against the real model, once**

This is the acceptance check for the whole phase. It downloads 479 MB.

```bash
cargo run --manifest-path crates/cowork-memory/Cargo.toml --release -- \
  --root /tmp/mem-smoke model --download

COWORK_MEMORY_MODEL_DIR=/tmp/mem-smoke/.model \
  cargo test --manifest-path crates/cowork-memory/Cargo.toml --release onnx -- --nocapture
```

Expected: the download reports progress and completes; `embeds_real_text_when_the_model_is_present` passes, including the cross-language assertion.

Then compare against the reference tool on the fixture corpus:

```bash
mkdir -p /tmp/mem-smoke/ws-1
cp crates/cowork-memory/tests/fixtures/notes/*.md /tmp/mem-smoke/ws-1/

cargo run --manifest-path crates/cowork-memory/Cargo.toml --release -- \
  --root /tmp/mem-smoke search "как работает планировщик" --scope ws-1
```

Expected: `01-tldr-and-sections.md` ranks first. A query sharing no words with the note is the point of the exercise.

- [ ] **Step 7: Staging script**

Create `scripts/stage-memory.sh`:

```bash
#!/usr/bin/env bash
# Builds the cowork_memory sidecar and stages it as a Tauri "externalBin"
# next to cowork_report. Mirrors scripts/stage-reporter.sh.
#
#   npm run stage:memory
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET_TRIPLE="$(rustc -Vv | grep host | cut -d' ' -f2)"

EXT=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
esac

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/cowork_memory-${TARGET_TRIPLE}${EXT}"

if [ ! -e "$DEST" ]; then
  : > "$DEST"
fi

cargo build --release --bin cowork_memory --manifest-path crates/cowork-memory/Cargo.toml

SRC="crates/cowork-memory/target/release/cowork_memory${EXT}"
cp "$SRC" "$DEST"
echo "Staged memory sidecar: $DEST"
```

```bash
chmod +x scripts/stage-memory.sh
```

Add to `package.json` scripts:

```json
    "stage:memory": "bash scripts/stage-memory.sh"
```

> The sidecar is **not** added to `tauri.conf.json`'s `externalBin` in this phase. `tauri-build` validates that every declared `externalBin` exists on disk during *any* cargo build of the app crate, so declaring it now would break `cargo test` for anyone who has not staged it. It is declared in phase 3, when the app starts spawning it.

- [ ] **Step 8: Document it**

Add to `README.md` under `### Tests`:

```markdown
### Memory sidecar

`cowork_memory` is a separate crate under `crates/cowork-memory`. It builds and
tests independently of the app:

```bash
cargo test --manifest-path crates/cowork-memory/Cargo.toml
npm run stage:memory     # build + stage the sidecar binary
```

Its tests use a deterministic fake embedder and need no model. To exercise the
real one, download it first (479 MB) and point the tests at it:

```bash
cargo run --manifest-path crates/cowork-memory/Cargo.toml -- --root <dir> model --download
COWORK_MEMORY_MODEL_DIR=<dir>/.model cargo test --manifest-path crates/cowork-memory/Cargo.toml onnx
```
```

- [ ] **Step 9: Verify nothing regressed in the app**

Run:

```bash
npm run stage:reporter
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

Expected: PASS — 2 backend tests, 131 frontend tests. Phase 1 touches no app code, so any change here is a mistake.

- [ ] **Step 10: Commit**

```bash
git add crates/cowork-memory scripts/stage-memory.sh package.json README.md
git commit -m "feat(memory): ONNX embedder, model download command, sidecar staging"
```

---

## Done when

- `cargo test --manifest-path crates/cowork-memory/Cargo.toml` passes with no model and no network.
- The golden test proves chunking matches the Python reference on every fixture.
- With the real model downloaded, a query sharing no vocabulary with a note still retrieves it, and a Russian query retrieves an English note.
- `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml` are unchanged — phase 1 touches no app code.

## Not in this phase

Capture, the wrapup queue, rooms configuration, MCP, palette search, settings UI. Those are phases 2 and 3 of the spec.

Also deliberately absent: the **index write lock** the spec calls for. Phase 1 has a
single writer by construction — one CLI process at a time. The lock becomes necessary
in phase 2, when queue workers can finish concurrently, and belongs with the code that
creates the contention. Do not add it here; do not forget it there.
