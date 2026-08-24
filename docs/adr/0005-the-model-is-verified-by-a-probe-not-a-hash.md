---
status: Accepted
date: 2026-08-24
deciders:
  - evgenykharetski
---

# ADR-0005 — The embedding model is downloaded, and verified by a probe rather than a hash

## Context

The embedder needs `model.onnx` (470 MB) and `tokenizer.json` (9 MB). Bundling
them would multiply the installer's size by roughly an order of magnitude, for a
feature that is opt-in.

Downloading raises the usual question of integrity. The normal answer is a
published checksum, and it is not available: the host publishes no sha256 for
these files.

Corruption here fails quietly, which is what makes it worth designing against. A
truncated or damaged ONNX file may still load, and a model that loads produces
vectors. Those vectors are meaningless, every search returns plausible-looking
nonsense, and nothing in the system reports a fault.

## Decision

**Download on demand, resuming into `<name>.part`, renaming only once the byte
count matches exactly.** What looks complete is complete: a short `.part`
survives to be resumed rather than being promoted to a finished file.

**Verify by running a probe string through the loaded model**, not by hashing the
file. The probe checks three properties separately, so a failure says which one
broke: every component finite, the vector the expected width, and unit length.

The width check is what rejects a different model variant, which is the
realistic way a wrong file gets staged. A *different* 384-dimensional sentence
transformer would still pass, and that is accepted: it degrades retrieval quality
rather than breaking correctness, and the corpus is re-indexed with it wholesale.

The embedder's `dim` is taken from the vector the probe produced, not from the
constant it was checked against. The constant is the assertion; using it as the
value too would make a probe that never ran indistinguishable from one that
passed.

## Consequences

Memory does not work until a download the user has to consent to has finished,
and the first run of the feature is a 479 MB wait.

The download needs a deadline of its own. A mirror that accepts the connection
and then goes quiet holds it open forever, and size verification cannot help
because nothing arrives. The timeout bounds a single socket read rather than the
whole transfer — a deadline on the request as a whole would abort a download that
is merely slow, which on 470 MB is the common case.

An interrupted download is progress rather than absence, so the model's state has
three values and not two. Reporting a resumable `.part` as "absent" would invite
the person to start the whole download again while the bytes are already there.

If the host ever publishes checksums, this decision should be revisited — a hash
is a cheaper and stricter check than a forward pass.

## Alternatives considered

**Bundle the model.** Rejected: an order of magnitude on the installer for an
opt-in feature, on every platform, updated on every release.

**Hash the file against a value we compute ourselves once.** Rejected: it pins
the artefact to whatever was downloaded on one machine on one day, and the host
is free to re-upload an equivalent file. The failure mode is refusing a good
model, which is worse than accepting a different good one.

**Check only the file size.** Rejected: it is already how the `.part` rename is
gated, and it says nothing about the bytes in between.

**Trust the download.** Rejected: the failure is silent, and its symptom —
search returning confident nonsense — is indistinguishable from the feature
simply being bad.
