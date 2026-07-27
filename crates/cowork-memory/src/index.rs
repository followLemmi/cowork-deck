use crate::scan::FileStat;
use anyhow::{bail, Result};
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

fn fnv_eat(h: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *h ^= *b as u64;
        *h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

/// Ties `emb.bin` to the exact chunk list it was computed for. Without it, a
/// crash between the two writes in `save` can leave a stale matrix whose
/// length still matches, and the vectors would silently stop corresponding to
/// their texts.
fn fingerprint(chunks: &[ChunkRecord], dim: usize) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    fnv_eat(&mut h, &(dim as u64).to_le_bytes());
    fnv_eat(&mut h, &(chunks.len() as u64).to_le_bytes());
    for c in chunks {
        fnv_eat(&mut h, c.file.as_bytes());
        fnv_eat(&mut h, c.scope.as_bytes());
        fnv_eat(&mut h, c.room.as_deref().unwrap_or("").as_bytes());
        fnv_eat(&mut h, c.text.as_bytes());
    }
    h
}

/// Load the cache. Anything wrong with it yields an empty index, which the
/// caller rebuilds — the cache is disposable by design.
pub fn load(cache: &Path) -> Index {
    try_load(cache).unwrap_or_default()
}

fn try_load(cache: &Path) -> Option<Index> {
    let raw = std::fs::read_to_string(cache.join("meta.json")).ok()?;
    let meta: Meta = serde_json::from_str(&raw).ok()?;
    // dim 0 would make the length check below vacuous.
    if meta.dim == 0 && !meta.chunks.is_empty() {
        return None;
    }
    let bytes = std::fs::read(cache.join("emb.bin")).ok()?;
    if bytes.len() < 8 || (bytes.len() - 8) % 4 != 0 {
        return None;
    }
    let stamp = u64::from_le_bytes(bytes[..8].try_into().ok()?);
    if stamp != fingerprint(&meta.chunks, meta.dim) {
        return None; // this matrix belongs to a different chunk list
    }
    let emb: Vec<f32> = bytes[8..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if emb.len() != meta.chunks.len() * meta.dim {
        return None;
    }
    Some(Index { meta, emb })
}

pub fn save(cache: &Path, ix: &Index) -> Result<()> {
    if ix.meta.dim == 0 && !ix.meta.chunks.is_empty() {
        bail!("refusing to save {} chunks with dim 0", ix.meta.chunks.len());
    }
    if ix.emb.len() != ix.meta.chunks.len() * ix.meta.dim {
        bail!(
            "embedding matrix has {} floats, expected {} ({} chunks x dim {})",
            ix.emb.len(),
            ix.meta.chunks.len() * ix.meta.dim,
            ix.meta.chunks.len(),
            ix.meta.dim
        );
    }
    std::fs::create_dir_all(cache)?;

    let mut bytes = Vec::with_capacity(8 + ix.emb.len() * 4);
    bytes.extend_from_slice(&fingerprint(&ix.meta.chunks, ix.meta.dim).to_le_bytes());
    for f in &ix.emb {
        bytes.extend_from_slice(&f.to_le_bytes());
    }

    // Write to temporaries and rename, so a crash never leaves a truncated
    // file that load would try to interpret. A leftover .tmp is harmless.
    let meta_tmp = cache.join("meta.json.tmp");
    let emb_tmp = cache.join("emb.bin.tmp");
    std::fs::write(&meta_tmp, serde_json::to_vec(&ix.meta)?)?;
    std::fs::write(&emb_tmp, bytes)?;
    std::fs::rename(&emb_tmp, cache.join("emb.bin"))?;
    std::fs::rename(&meta_tmp, cache.join("meta.json"))?;
    Ok(())
}

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
        fs::write(dir.join("emb.bin"), [0u8; 4]).unwrap(); // too short to even hold the stamp
        assert!(load(&dir).meta.chunks.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The crash-between-two-writes case: a new `meta.json` beside an
    /// `emb.bin` from the previous save whose length still matches. A length
    /// check cannot see this; the fingerprint can.
    #[test]
    fn stale_emb_with_matching_length_forces_a_rebuild() {
        let dir = tmp("stale");
        save(&dir, &sample()).unwrap();

        let mut edited = sample();
        edited.meta.chunks[0].text = "переписанный текст".into();
        fs::write(dir.join("meta.json"), serde_json::to_vec(&edited.meta).unwrap()).unwrap();
        // emb.bin is untouched: same chunk count, same dim, same byte length.

        assert!(
            load(&dir).meta.chunks.is_empty(),
            "vectors that belong to a different chunk list must not be served"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_refuses_an_index_that_violates_its_own_invariant() {
        let dir = tmp("refuse");

        let mut short = sample();
        short.emb.pop(); // 1 float for a 1-chunk, dim-2 index
        assert!(save(&dir, &short).is_err(), "emb length must match chunks * dim");

        let mut zero = sample();
        zero.meta.dim = 0;
        zero.emb.clear();
        assert!(save(&dir, &zero).is_err(), "dim 0 with chunks makes the check vacuous");

        fs::remove_dir_all(&dir).unwrap();
    }

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
}
