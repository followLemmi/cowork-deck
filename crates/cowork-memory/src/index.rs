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
}
