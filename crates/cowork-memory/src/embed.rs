use anyhow::Result;

pub trait Embedder {
    fn dim(&self) -> usize;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
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
