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
