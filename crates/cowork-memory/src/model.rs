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
        if got > f.expected {
            // Only an oversized .part is unrecoverable. A server that ignores
            // Range re-sends the whole body, append grows the file past the
            // target, and from then on every run breaks out at
            // `have >= expected` and fails here identically — with no route
            // back to a good download short of deleting the file by hand.
            // Discard it so the next attempt starts clean. A short .part is
            // kept: that is the ordinary resume case and it is worth bytes.
            let _ = std::fs::remove_file(&part);
        }
        bail!("{} is {got} bytes, expected {}", f.name, f.expected);
    }
    std::fs::rename(&part, &final_path)?;
    progress(f.expected, f.expected);
    Ok(final_path)
}

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

    /// A server that ignores Range re-sends the whole body, which append grows
    /// past the target. Without discarding the result, the download is wedged
    /// for good.
    #[test]
    fn an_oversized_part_is_discarded_so_the_next_attempt_can_recover() {
        struct IgnoresRange {
            body: Vec<u8>,
        }
        impl Fetcher for IgnoresRange {
            fn fetch(&self, _url: &str, _from: u64) -> anyhow::Result<Box<dyn std::io::Read>> {
                Ok(Box::new(Cursor::new(self.body.clone())))
            }
        }

        let dir = tmp("oversize");
        let file = ModelFile { url: "x".into(), name: "model.onnx", expected: 1000 };
        // What an interrupted earlier run would have left behind.
        fs::write(dir.join("model.onnx.part"), vec![1u8; 600]).unwrap();

        let err = download_one(&dir, &file, &IgnoresRange { body: vec![2u8; 1000] }, &mut |_, _| {})
            .unwrap_err();
        assert!(err.to_string().contains("expected"), "got: {err}");
        assert!(
            !dir.join("model.onnx.part").exists(),
            "an oversized .part must not survive, or every later attempt fails the same way"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn is_present_requires_both_files_at_exact_size() {
        let dir = tmp("present");
        assert!(!is_present(&dir));
        fs::write(dir.join("model.onnx"), vec![0u8; 10]).unwrap();
        fs::write(dir.join("tokenizer.json"), vec![0u8; 10]).unwrap();
        assert!(!is_present(&dir), "wrong sizes must not count as present");

        // The success path too: this is the gate task 10 uses to skip the
        // download entirely, so it must be able to return true. set_len makes
        // a sparse file — allocating 470 MB in a unit test would not do.
        for f in files() {
            let fh = fs::File::create(dir.join(f.name)).unwrap();
            fh.set_len(f.expected).unwrap();
        }
        assert!(is_present(&dir), "both files at their exact size must count as present");

        fs::remove_dir_all(&dir).unwrap();
    }
}
