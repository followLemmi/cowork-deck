use anyhow::{bail, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

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

/// Timeouts for the download.
///
/// The model is 470 MB, so a deadline on the transfer as a whole is the wrong
/// tool: it would abort a download that is merely slow. What a timeout has to
/// catch is a connection that has stopped producing bytes altogether — without
/// one the download waits on a silent socket forever, and the only symptom the
/// app can show is a progress line that never advances.
///
/// ureq 2 had a per-read socket timeout, which was exactly that. ureq 3 only
/// has a deadline per phase of one request — connect, headers, body — so the
/// body is fetched as a sequence of `CHUNK`-sized `Range` requests and
/// `READ_TIMEOUT` bounds each of them. A stall is still caught within one
/// deadline. What the deadline now also imposes is a throughput floor of
/// `CHUNK / READ_TIMEOUT`, about 70 KB/s, at which the model would take two
/// hours to arrive anyway.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Bytes per ranged request. See `READ_TIMEOUT` for why it is not the whole body.
const CHUNK: u64 = 4 * 1024 * 1024;

pub struct HttpFetcher {
    agent: ureq::Agent,
    chunk: u64,
}

impl HttpFetcher {
    pub fn new() -> HttpFetcher {
        HttpFetcher::with_timeouts(CONNECT_TIMEOUT, READ_TIMEOUT)
    }

    /// The same fetcher with explicit timeouts, so a test can prove the
    /// deadline fires without waiting a minute for it.
    pub fn with_timeouts(connect: Duration, read: Duration) -> HttpFetcher {
        HttpFetcher::with_timeouts_and_chunk(connect, read, CHUNK)
    }

    /// And with an explicit chunk size, so a test can walk the chunk
    /// boundaries on a body of a few hundred bytes.
    fn with_timeouts_and_chunk(connect: Duration, read: Duration, chunk: u64) -> HttpFetcher {
        let config = ureq::Agent::config_builder()
            .timeout_connect(Some(connect))
            .timeout_recv_response(Some(read))
            .timeout_recv_body(Some(read))
            .build();
        HttpFetcher { agent: config.into(), chunk }
    }
}

impl Default for HttpFetcher {
    fn default() -> HttpFetcher {
        HttpFetcher::new()
    }
}

impl Fetcher for HttpFetcher {
    fn fetch(&self, url: &str, from: u64) -> Result<Box<dyn Read>> {
        let mut reader = ChunkedReader {
            agent: self.agent.clone(),
            url: url.to_string(),
            chunk: self.chunk,
            pos: from,
            current: None,
            in_chunk: 0,
            ranged: true,
            done: false,
        };
        // Open the first chunk here rather than on the first `read`, so a
        // server that never answers is reported by `fetch` itself, as it was
        // when one request carried the whole body.
        reader.open()?;
        Ok(Box::new(reader))
    }
}

/// The body as a sequence of ranged requests, each under its own deadline.
struct ChunkedReader {
    agent: ureq::Agent,
    url: String,
    chunk: u64,
    /// The next byte to ask for.
    pos: u64,
    /// The chunk being read, if one is open.
    current: Option<Box<dyn Read>>,
    /// Bytes read from `current` so far.
    in_chunk: u64,
    /// Whether the server honoured `Range`. One that ignores it answers 200
    /// with the whole body; that body is then all there is, and asking for
    /// more would only make it re-send everything.
    ranged: bool,
    done: bool,
}

impl ChunkedReader {
    /// Request the chunk starting at `pos`. A 416 marks the end of the body
    /// instead of failing: it is what the server says when the previous chunk
    /// ended exactly on the last byte.
    fn open(&mut self) -> Result<()> {
        let end = self.pos + self.chunk - 1;
        let resp = match self
            .agent
            .get(&self.url)
            .header("Range", format!("bytes={}-{end}", self.pos))
            .call()
        {
            Ok(resp) => resp,
            Err(ureq::Error::StatusCode(416)) => {
                self.done = true;
                return Ok(());
            }
            Err(e) => return Err(e.into()),
        };
        self.ranged = resp.status() == ureq::http::StatusCode::PARTIAL_CONTENT;
        self.in_chunk = 0;
        self.current = Some(Box::new(resp.into_body().into_reader()));
        Ok(())
    }
}

impl Read for ChunkedReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.done {
                return Ok(0);
            }
            let Some(body) = self.current.as_mut() else {
                self.open().map_err(std::io::Error::other)?;
                continue;
            };
            let n = body.read(buf)?;
            if n > 0 {
                self.pos += n as u64;
                self.in_chunk += n as u64;
                return Ok(n);
            }
            // This chunk is spent. A full one may have more behind it; a short
            // one, or an unranged whole body, was the end.
            self.current = None;
            if !self.ranged || self.in_chunk < self.chunk {
                self.done = true;
            }
        }
    }
}

/// What the model directory holds, and how far along it is.
pub struct ModelStatus {
    /// `absent`, `partial` or `present`.
    pub state: &'static str,
    /// Bytes on disk that count towards a finished download.
    pub have: u64,
    /// Bytes when complete.
    pub total: u64,
}

/// The model's state, for a UI that has to decide what to offer.
///
/// Three states rather than a boolean, and `partial` is the reason. An
/// interrupted download leaves a `.part` that `download_one` will resume from,
/// so reporting it as "absent" would invite the person to start 470 MB over
/// from nothing — while the bytes it would re-fetch are already sitting there.
///
/// A file present at the wrong size counts for nothing: `download_one` only
/// renames out of `.part` once the length matches exactly, so a final file of
/// the wrong length was not written by us and is not resumable.
pub fn status(dir: &Path) -> ModelStatus {
    let mut have = 0u64;
    let mut total = 0u64;
    let mut complete = 0usize;
    let all = files();
    for f in &all {
        total += f.expected;
        let final_len = std::fs::metadata(dir.join(f.name)).map(|m| m.len()).unwrap_or(0);
        if final_len == f.expected {
            have += f.expected;
            complete += 1;
            continue;
        }
        have += std::fs::metadata(dir.join(format!("{}.part", f.name)))
            .map(|m| m.len())
            .unwrap_or(0)
            .min(f.expected);
    }
    let state = if complete == all.len() {
        "present"
    } else if have > 0 {
        "partial"
    } else {
        "absent"
    };
    ModelStatus { state, have, total }
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
            // Discard it so the next attempt starts clean.
            //
            // The guard looks redundant today: the loop only leaves via
            // `have >= expected`, and a stalled transfer bails earlier without
            // touching the file, so `got < expected` cannot occur here. Keep it
            // anyway. Give the loop a retry cap or any other early exit and
            // that state becomes reachable at once, and an unconditional
            // remove would then silently throw away every partial download —
            // turning resume into a restart that nobody notices except on the
            // bandwidth bill.
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
    use std::net::TcpListener;

    #[test]
    fn model_state_tells_absent_from_partial_from_present() {
        let dir = std::env::temp_dir().join(format!("cwm-model-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let all = files();

        let st = status(&dir);
        assert_eq!(st.state, "absent", "nothing on disk");
        assert_eq!(st.have, 0);
        assert_eq!(st.total, all.iter().map(|f| f.expected).sum::<u64>());

        // A resumable `.part` is progress, not absence.
        fs::write(dir.join(format!("{}.part", all[0].name)), vec![0u8; 64]).unwrap();
        let st = status(&dir);
        assert_eq!(st.state, "partial", "a .part must not read as absent");
        assert_eq!(st.have, 64);

        // A final file at the wrong size was not written by us: `download_one`
        // renames only on an exact match, so it counts for nothing.
        fs::write(dir.join(all[1].name), vec![0u8; 8]).unwrap();
        assert_eq!(status(&dir).have, 64, "a short final file is not progress");

        // `set_len`, not `write`: these two files are 479 MB between them, and a
        // test that actually allocates them is a test nobody runs twice. The
        // hole costs nothing and `metadata().len()` reports the full length,
        // which is all `status` looks at.
        for f in &all {
            let _ = fs::remove_file(dir.join(format!("{}.part", f.name)));
            let h = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(dir.join(f.name))
                .unwrap();
            h.set_len(f.expected).unwrap();
        }
        let st = status(&dir);
        assert_eq!(st.state, "present");
        assert_eq!(st.have, st.total);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A socket that accepts and then says nothing, which is what a stalled
    /// mirror looks like from here. Without a read timeout this test hangs
    /// forever rather than failing — which is exactly the production symptom.
    #[test]
    fn a_silent_server_fails_on_the_read_timeout_instead_of_hanging() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        // Held open, never written to. The thread is detached and dies with the
        // test process; parking it keeps the accepted connection alive so the
        // client waits on silence rather than on a closed socket.
        std::thread::spawn(move || {
            let _keep = listener.accept();
            std::thread::park();
        });

        let f = HttpFetcher::with_timeouts(
            Duration::from_millis(200),
            Duration::from_millis(200),
        );
        let started = std::time::Instant::now();
        let out = f.fetch(&format!("http://{addr}/model.onnx"), 0);

        assert!(out.is_err(), "a server that never answers must not succeed");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "gave up after {:?} — the timeout is not being applied",
            started.elapsed()
        );
    }

    /// A loopback server that speaks just enough HTTP to answer ranged GETs
    /// for one body the way a model mirror does: 206 with a `Content-Range`,
    /// 416 once asked for bytes past the end. `stall_after` makes it fall
    /// silent that many body bytes into every response, which is what a dying
    /// connection looks like from here. Every request it sees is recorded in
    /// `ranges`.
    struct RangeServer {
        addr: std::net::SocketAddr,
        ranges: std::sync::Arc<std::sync::Mutex<Vec<(u64, u64)>>>,
    }

    fn range_server(body: Vec<u8>, stall_after: Option<usize>) -> RangeServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let ranges = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = ranges.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let body = body.clone();
                let seen = seen.clone();
                std::thread::spawn(move || {
                    let mut req = Vec::new();
                    let mut b = [0u8; 1];
                    while !req.ends_with(b"\r\n\r\n") {
                        if s.read(&mut b).unwrap_or(0) == 0 {
                            return;
                        }
                        req.push(b[0]);
                    }
                    let req = String::from_utf8_lossy(&req).to_ascii_lowercase();
                    let len = body.len() as u64;
                    let (a, b) = req
                        .lines()
                        .find_map(|l| l.strip_prefix("range: bytes="))
                        .and_then(|r| r.split_once('-'))
                        .map(|(a, b)| (a.parse::<u64>().unwrap(), b.parse::<u64>().unwrap()))
                        .unwrap_or((0, len.saturating_sub(1)));
                    seen.lock().unwrap().push((a, b));
                    if a >= len {
                        let head = format!(
                            "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = s.write_all(head.as_bytes());
                        return;
                    }
                    let b = b.min(len - 1);
                    let slice = &body[a as usize..=b as usize];
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {a}-{b}/{len}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        slice.len()
                    );
                    let _ = s.write_all(head.as_bytes());
                    match stall_after {
                        Some(n) if n < slice.len() => {
                            let _ = s.write_all(&slice[..n]);
                            let _ = s.flush();
                            std::thread::park();
                        }
                        _ => {
                            let _ = s.write_all(slice);
                        }
                    }
                });
            }
        });
        RangeServer { addr, ranges }
    }

    fn pattern(len: u32) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    /// The reader stitches the ranged chunks back into the one body the
    /// caller asked for, and picks up exactly where a resume says to.
    #[test]
    fn chunks_are_stitched_back_into_one_body_from_the_resume_point() {
        let body = pattern(1000);
        let server = range_server(body.clone(), None);
        let f = HttpFetcher::with_timeouts_and_chunk(
            Duration::from_secs(5),
            Duration::from_secs(5),
            300,
        );

        let mut got = Vec::new();
        f.fetch(&format!("http://{}/model.onnx", server.addr), 250)
            .unwrap()
            .read_to_end(&mut got)
            .unwrap();

        assert_eq!(got, body[250..], "content must be exact from the resume point");
        assert_eq!(
            *server.ranges.lock().unwrap(),
            vec![(250, 549), (550, 849), (850, 1149)],
            "one request per chunk, starting at the resume point, the last one short"
        );
    }

    /// A body that ends exactly on a chunk boundary gives the reader no short
    /// chunk to stop on. It asks once more, and the 416 is the answer.
    #[test]
    fn a_body_ending_on_a_chunk_boundary_finishes_on_the_416() {
        let body = pattern(900);
        let server = range_server(body.clone(), None);
        let f = HttpFetcher::with_timeouts_and_chunk(
            Duration::from_secs(5),
            Duration::from_secs(5),
            300,
        );

        let mut got = Vec::new();
        f.fetch(&format!("http://{}/model.onnx", server.addr), 0)
            .unwrap()
            .read_to_end(&mut got)
            .unwrap();

        assert_eq!(got, body);
        assert_eq!(
            server.ranges.lock().unwrap().len(),
            4,
            "three chunks and the request that learns there is no fourth"
        );
    }

    /// The case the timeouts exist for: headers arrive, some bytes arrive, and
    /// then the connection goes quiet for good. ureq 3 has no per-read
    /// timeout, so this only fails fast because each chunk is its own request
    /// under its own deadline. The bytes that did arrive are handed over
    /// first, so the resume has them.
    #[test]
    fn a_connection_that_dies_mid_body_fails_on_the_chunk_deadline() {
        let body = pattern(1000);
        let server = range_server(body.clone(), Some(100));
        let f = HttpFetcher::with_timeouts_and_chunk(
            Duration::from_millis(200),
            Duration::from_millis(200),
            300,
        );

        let started = std::time::Instant::now();
        let mut reader = f
            .fetch(&format!("http://{}/model.onnx", server.addr), 0)
            .expect("headers arrive, so fetch itself succeeds");
        let mut got = Vec::new();
        let mut buf = [0u8; 64];
        let err = loop {
            match reader.read(&mut buf) {
                Ok(0) => panic!("a stalled body must not read as complete"),
                Ok(n) => got.extend_from_slice(&buf[..n]),
                Err(e) => break e,
            }
        };

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "gave up after {:?} — the body deadline is not being applied",
            started.elapsed()
        );
        assert_eq!(got, body[..100], "what arrived before the stall must be delivered: {err}");
    }

    /// End to end through `download_one`: a `.part` from an earlier run, the
    /// rest fetched in chunks over real HTTP, the exact file renamed into
    /// place.
    #[test]
    fn download_one_resumes_over_http_in_chunks() {
        let body = pattern(1000);
        let server = range_server(body.clone(), None);
        let dir = tmp("http-resume");
        fs::write(dir.join("model.onnx.part"), &body[..250]).unwrap();
        let file = ModelFile {
            url: format!("http://{}/model.onnx", server.addr),
            name: "model.onnx",
            expected: 1000,
        };
        let f = HttpFetcher::with_timeouts_and_chunk(
            Duration::from_secs(5),
            Duration::from_secs(5),
            300,
        );

        let path = download_one(&dir, &file, &f, &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(&path).unwrap(), body);
        assert_eq!(server.ranges.lock().unwrap()[0], (250, 549), "must resume, not restart");
        fs::remove_dir_all(&dir).unwrap();
    }

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

        // The other half of the asymmetry, and the reason resume exists at
        // all: a failed short transfer keeps what it already fetched. Without
        // this assertion, a change that discards partial downloads
        // unconditionally would pass the whole suite, and a 470 MB file would
        // quietly restart from zero on every attempt.
        let part = dir.join("model.onnx.part");
        assert!(part.exists(), "a short .part must survive for the next attempt");
        assert_eq!(
            fs::metadata(&part).unwrap().len(),
            500,
            "the bytes already fetched must still be there"
        );

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
