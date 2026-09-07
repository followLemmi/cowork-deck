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

    // Hit's field names are a published interface: the desktop app parses this
    // JSON in later phases. Assert on every field, so a rename cannot pass.
    let diary = hits
        .iter()
        .find(|h| h["file"].as_str().unwrap().starts_with("Diaries/"))
        .expect("diary hit");
    assert!(diary["score"].is_number(), "score must be numeric: {diary}");
    assert_eq!(diary["scope"], "__diaries__");
    assert_eq!(diary["room"], "reviewer");
    assert!(diary["text"].as_str().is_some_and(|s| !s.is_empty()));
    // #462 added `date`, and it is part of the same published interface: the
    // app's `sidecar::Hit` mirrors this object field for field.
    assert_eq!(diary["date"], "2026-07", "a diary is dated to its month");

    let ws = hits
        .iter()
        .find(|h| h["file"].as_str().unwrap().starts_with("ws-1/"))
        .expect("workspace hit");
    assert!(ws["room"].is_null(), "a workspace hit has no room");
    assert_eq!(ws["date"], "2026-07-27", "a session note is dated to its day");

    fs::remove_dir_all(&root).unwrap();
}

/// #462: the app's prompt hook sends a period when the question names one, and
/// this is the boundary it sends it across.
#[test]
fn a_search_can_be_confined_to_a_period() {
    let root = fixture_root("window");
    fs::create_dir_all(root.join("ws-1/Sessions/2026-09")).unwrap();
    let body = "Планировщик получил окно поиска по датам, чтобы вопрос про вчерашний                 день не отвечался заметкой из другого месяца. ";
    fs::write(
        root.join("ws-1/Sessions/2026-09/06-window.md"),
        format!("# Окно поиска\n\n## TL;DR\n{}\n", body.repeat(2)),
    )
    .unwrap();

    let files = |args: &[&str]| -> Vec<String> {
        let (stdout, stderr, ok) = run(&root, args);
        assert!(ok, "search failed: {stderr}");
        let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
        v.as_array()
            .unwrap()
            .iter()
            .map(|h| h["file"].as_str().unwrap().to_string())
            .collect()
    };

    let base = ["search", "что мы делали", "--scope", "ws-1", "--min-score", "-1", "--json"];

    let all = files(&base);
    assert!(all.len() >= 3, "everything, unwindowed: {all:?}");

    let mut september =
        files(&[&base[..], &["--since", "2026-09-01", "--until", "2026-09-30"]].concat());
    september.sort();
    assert_eq!(september, vec!["ws-1/Sessions/2026-09/06-window.md"], "one day's work");

    let mut july = files(&[&base[..], &["--since", "2026-07", "--until", "2026-07"]].concat());
    july.sort();
    assert_eq!(
        july,
        vec!["Diaries/reviewer/2026-07.md", "ws-1/Sessions/2026-07/27-scheduler.md"],
        "a bare month means the whole of it, and the diary overlaps it"
    );

    let nothing = files(&[&base[..], &["--since", "2026-01", "--until", "2026-01"]].concat());
    assert!(nothing.is_empty(), "a period with no notes in it: {nothing:?}");

    // A bound nobody could read is a failure, not a window quietly dropped —
    // which would answer a question about last week with a note from July.
    let (_, stderr, ok) = run(&root, &[&base[..], &["--since", "yesterday"]].concat());
    assert!(!ok, "an unreadable bound must fail");
    assert!(stderr.contains("YYYY-MM-DD"), "and say what a date looks like: {stderr}");

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_update_over_an_empty_corpus_reports_empty_not_absent() {
    let root = std::env::temp_dir().join(format!("cwm-cli-void-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("ws-1")).unwrap();

    let (stdout, _, _) = run(&root, &["status", "--json"]);
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["state"], "absent", "no update has run yet: {stdout}");

    let (_, stderr, ok) = run(&root, &["update"]);
    assert!(ok, "update failed: {stderr}");

    let (stdout, _, _) = run(&root, &["status", "--json"]);
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["state"], "empty", "an update ran and found nothing: {stdout}");
    assert_eq!(v["chunks"], 0);

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn status_tells_an_absent_index_from_a_built_one() {
    let root = fixture_root("state");

    let (stdout, stderr, ok) = run(&root, &["status", "--json"]);
    assert!(ok, "status failed: {stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["state"], "absent", "nothing has been indexed yet: {stdout}");

    let (_, stderr, ok) = run(&root, &["update"]);
    assert!(ok, "update failed: {stderr}");

    let (stdout, _, _) = run(&root, &["status", "--json"]);
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["state"], "ready", "got: {stdout}");

    fs::remove_dir_all(&root).unwrap();
}

/// On an incremental indexer the question a verbose run is asked is *which*
/// files were re-embedded. A count cannot answer it, and neither can the two
/// paths this used to print.
#[test]
fn verbose_update_names_the_files_it_reindexed() {
    let root = fixture_root("verbose");

    let (_, stderr, ok) = run(&root, &["update", "--verbose"]);
    assert!(ok, "update failed: {stderr}");
    assert!(
        stderr.contains("reindexed ws-1/Sessions/2026-07/27-scheduler.md"),
        "the first run must name what it indexed: {stderr}"
    );

    // Nothing touched since: the run has to say so rather than repeat the list.
    let (_, stderr, ok) = run(&root, &["update", "--verbose"]);
    assert!(ok, "second update failed: {stderr}");
    assert!(!stderr.contains("reindexed "), "nothing changed: {stderr}");
    assert!(stderr.contains("nothing changed"), "got: {stderr}");

    // One file edited: exactly that one comes back, and the diary does not.
    fs::write(
        root.join("ws-1/Sessions/2026-07/27-scheduler.md"),
        "# Планировщик\n\n## TL;DR\nПереписано целиком, поэтому файл обязан переиндексироваться заново.\n",
    )
    .unwrap();
    let (_, stderr, ok) = run(&root, &["update", "--verbose"]);
    assert!(ok, "third update failed: {stderr}");
    assert!(
        stderr.contains("reindexed ws-1/Sessions/2026-07/27-scheduler.md"),
        "the edited file must be named: {stderr}"
    );
    assert!(
        !stderr.contains("reindexed Diaries/"),
        "an untouched file must not be re-embedded: {stderr}"
    );

    fs::remove_dir_all(&root).unwrap();
}

/// The app reads this JSON to decide what its settings panel offers, and the
/// index says nothing about the model: the cache outlives a deleted model, so a
/// `ready` index alongside a missing model is an ordinary state, not a
/// contradiction. Both have to be reported, or the panel guesses.
#[test]
fn status_json_reports_the_model_separately_from_the_index() {
    let root = fixture_root("modelstate");

    let (stdout, stderr, ok) = run(&root, &["status", "--json"]);
    assert!(ok, "status failed: {stderr}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["state"], "absent", "no index yet: {stdout}");
    assert_eq!(v["model"]["state"], "absent", "no model either: {stdout}");
    assert_eq!(v["model"]["have"], 0);
    assert!(
        v["model"]["total"].as_u64().unwrap() > 0,
        "the download size must be known before the download: {stdout}"
    );
    assert!(v["model"]["dir"].is_string(), "the panel needs the path: {stdout}");

    // An index built with the fake embedder leaves the model exactly as absent
    // as it was — which is the pairing the panel has to be able to show.
    let (_, stderr, ok) = run(&root, &["update"]);
    assert!(ok, "update failed: {stderr}");
    let (stdout, _, _) = run(&root, &["status", "--json"]);
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["state"], "ready", "got: {stdout}");
    assert_eq!(v["model"]["state"], "absent", "got: {stdout}");

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

/// The guard that exists because it was needed: measuring with
/// `COWORK_MEMORY_FAKE_EMBED` against a real corpus rebuilt its 384-dimension
/// index at 64, and every search afterwards answered "reindex is required".
/// Nothing was lost that a reindex did not restore — the index is a disposable
/// cache (ADR-0004) — but a test affordance must not be able to do that.
#[test]
fn the_fake_embedder_refuses_to_rebuild_an_index_the_real_one_built() {
    let root = fixture_root("clobber");
    // An index as a real model would leave it: a width this embedder does not have.
    let cache = root.join(".index");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(
        cache.join("meta.json"),
        r#"{"files":{},"chunks":[{"file":"a.md","scope":"ws-1","room":null,"text":"x"}],"dim":384}"#,
    )
    .unwrap();
    std::fs::write(cache.join("emb.bin"), [0u8; 8]).unwrap();

    let (_out, stderr, ok) = run(&root, &["search", "запрос", "--json"]);
    assert!(!ok, "it must refuse rather than rebuild");
    assert!(stderr.contains("refusing to reindex"), "{stderr}");
    assert!(stderr.contains("384"), "and name the width it would have destroyed: {stderr}");

    // And the index is untouched.
    let meta = std::fs::read_to_string(cache.join("meta.json")).unwrap();
    assert!(meta.contains("\"dim\":384"));
}
