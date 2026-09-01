use anyhow::Result;
use std::cell::OnceCell;

pub trait Embedder {
    fn dim(&self) -> usize;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

/// An embedder built at most once, on the first call that needs one.
///
/// Two properties, and the second is the one that was missing.
///
/// **Not built until asked.** Loading the model costs seconds and hundreds of
/// megabytes, and a process that is never asked to search should pay neither —
/// which is why `mcp::serve` took a closure rather than a value.
///
/// **Built once.** The closure was called per tool call, so a session asking
/// three questions paid three graph builds: measured at 2.0 s and a 1.8 GB peak
/// each, of which 0.02 s is everything that is not the model. In a process that
/// outlives one request that is not a cost, it is a defect (#389).
///
/// A failure is not cached. The ordinary reason to fail is a model that has not
/// finished downloading, which stops being true without the process restarting.
pub struct Lazy<'a> {
    build: &'a dyn Fn() -> Result<Box<dyn Embedder>>,
    cell: OnceCell<Box<dyn Embedder>>,
}

impl<'a> Lazy<'a> {
    pub fn new(build: &'a dyn Fn() -> Result<Box<dyn Embedder>>) -> Lazy<'a> {
        Lazy { build, cell: OnceCell::new() }
    }

    /// The embedder, building it if this is the first ask.
    pub fn get(&self) -> Result<&dyn Embedder> {
        if let Some(e) = self.cell.get() {
            return Ok(e.as_ref());
        }
        let built = (self.build)()?;
        // `set` can only fail if another `get` won the race, which cannot happen
        // without threads — and this cell is deliberately single-threaded, since
        // the loop that owns it reads one request at a time.
        let _ = self.cell.set(built);
        Ok(self.cell.get().expect("just set").as_ref())
    }

    /// Whether the model is loaded. For a caller that wants to say so rather
    /// than to use it.
    pub fn is_loaded(&self) -> bool {
        self.cell.get().is_some()
    }
}

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
