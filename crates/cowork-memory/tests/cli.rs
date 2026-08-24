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

    let ws = hits
        .iter()
        .find(|h| h["file"].as_str().unwrap().starts_with("ws-1/"))
        .expect("workspace hit");
    assert!(ws["room"].is_null(), "a workspace hit has no room");

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
