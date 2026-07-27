use crate::embed::Embedder;
use anyhow::{bail, Context, Result};
use ndarray::Array2;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::TensorRef;
use std::path::Path;
use std::sync::Mutex;
use tokenizers::Tokenizer;

/// The dimension `paraphrase-multilingual-MiniLM-L12-v2` produces. The probe
/// checks against it, so a differently sized model fails loudly at load rather
/// than quietly poisoning the index.
const EXPECTED_DIM: usize = 384;
const MODEL_REPO: &str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";

/// What this actually guarantees, stated plainly: the graph loads and produces
/// finite numbers of the expected width. It does NOT authenticate the model —
/// `forward` L2-normalises its own output, so the unit-norm test passes for any
/// non-degenerate hidden state. The width check is what carries the weight
/// here: it rejects a different model variant, which is the realistic way a
/// wrong file gets staged. A different 384-dimensional sentence transformer
/// would still pass, and that is accepted: it degrades retrieval quality rather
/// than breaking correctness, and the corpus is re-indexed with it wholesale.
///
/// Each property reports separately, so a failure says which one broke.
fn verify_probe(v: &[f32]) -> Result<()> {
    if !v.iter().all(|x| x.is_finite()) {
        bail!("model loaded but produced a non-finite probe vector — the file is likely corrupt");
    }
    if v.len() != EXPECTED_DIM {
        bail!(
            "model produced {}-dimensional vectors, expected {EXPECTED_DIM} — \
             this is not {MODEL_REPO}",
            v.len()
        );
    }
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if (norm - 1.0).abs() > 1e-2 {
        bail!("probe vector is not unit length ({norm}) — the file is likely corrupt");
    }
    Ok(())
}

pub struct OnnxEmbedder {
    /// `Session::run` needs `&mut self`, but `Embedder::embed` takes `&self`.
    /// A mutex is the cheap way to bridge that without making every caller
    /// hold the embedder mutably.
    session: Mutex<Session>,
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

        let has_token_type_ids = session.inputs.iter().any(|i| i.name == "token_type_ids");

        let e = OnnxEmbedder {
            session: Mutex::new(session),
            tokenizer,
            has_token_type_ids,
            dim: 0,
        };
        let probe = e.forward(&["проверка".to_string()])?;
        verify_probe(&probe[0])?;
        Ok(OnnxEmbedder { dim: EXPECTED_DIM, ..e })
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

        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("embedding session is poisoned by an earlier panic"))?;
        let outputs = session.run(inputs)?;
        let (shape, hidden) = outputs[0].try_extract_tensor::<f32>()?;
        // (batch, seq, hidden). Checked rather than indexed blindly so that a
        // model with the wrong output rank fails `load`'s probe with a message
        // instead of panicking inside it.
        if shape.len() != 3 {
            bail!("expected a (batch, seq, hidden) output, got shape {shape:?}");
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_fails_clearly_when_the_model_is_absent() {
        let dir = std::env::temp_dir().join(format!("cwm-onnx-absent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // map(drop): unwrap_err needs the Ok type to be Debug, and an ort
        // Session is not.
        let err = OnnxEmbedder::load(&dir).map(drop).unwrap_err().to_string();
        assert!(err.contains("model"), "unhelpful error: {err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A unit-length vector of `n` dimensions, so each probe test isolates the
    /// one property it is about.
    fn unit(n: usize) -> Vec<f32> {
        let mut v = vec![0f32; n];
        v[0] = 1.0;
        v
    }

    #[test]
    fn probe_accepts_a_finite_unit_vector_of_the_expected_width() {
        verify_probe(&unit(EXPECTED_DIM)).unwrap();
    }

    /// The check that carries the weight. `forward` normalises its own output,
    /// so width is the only one of the three that a wrong-but-well-formed model
    /// can fail.
    #[test]
    fn probe_rejects_a_model_of_a_different_width() {
        let err = verify_probe(&unit(768)).unwrap_err().to_string();
        assert!(err.contains("768"), "must name the actual width: {err}");
        assert!(err.contains("384"), "must name the expected width: {err}");
        assert!(err.contains(MODEL_REPO), "must name the expected model: {err}");

        // Degenerate but reachable: an empty vector is a width mismatch too,
        // and must not slip through the vacuously-true finiteness test.
        let err = verify_probe(&[]).unwrap_err().to_string();
        assert!(err.contains("0-dimensional"), "empty must be rejected: {err}");
    }

    #[test]
    fn probe_rejects_a_non_finite_vector() {
        let mut v = unit(EXPECTED_DIM);
        v[1] = f32::NAN;
        let err = verify_probe(&v).unwrap_err().to_string();
        assert!(err.contains("non-finite"), "must say which property broke: {err}");
    }

    #[test]
    fn probe_rejects_a_vector_that_is_not_unit_length() {
        let mut v = unit(EXPECTED_DIM);
        v[0] = 0.3;
        let err = verify_probe(&v).unwrap_err().to_string();
        assert!(err.contains("unit length"), "must say which property broke: {err}");
    }

    /// Needs the real 479 MB model, so it is `#[ignore]`d rather than skipped
    /// at runtime: a test that returns early still reports as passing, and a
    /// green suite would wrongly imply the embedder was exercised. Run it with
    /// `cargo test -- --ignored` once `COWORK_MEMORY_MODEL_DIR` points at the
    /// downloaded model.
    #[test]
    #[ignore = "requires the downloaded model; set COWORK_MEMORY_MODEL_DIR and run with --ignored"]
    fn embeds_real_text_when_the_model_is_present() {
        let dir = std::env::var("COWORK_MEMORY_MODEL_DIR")
            .expect("COWORK_MEMORY_MODEL_DIR must point at the directory holding model.onnx and tokenizer.json");
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
