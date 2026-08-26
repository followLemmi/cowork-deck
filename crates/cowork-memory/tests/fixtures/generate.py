#!/usr/bin/env python3
"""Regenerates the machine-written fixtures and `golden.json`.

`golden.json` is not expected output someone typed — it is what the reference
implementation actually returns, recorded. That reference is the working
`vault-index` at `~/.claude/bin/vault_index.py`, which this script imports.

That path is the author's machine and nobody else's, which is a real limit and
not an oversight: the *generated* file is committed, so `cargo test` proves
parity for everyone, and only regenerating it needs the reference to hand. If
you have no reference, do not regenerate — a golden file produced from the Rust
implementation would assert that the port agrees with itself.

    python3 crates/cowork-memory/tests/fixtures/generate.py

Fixtures 01-06 are hand-written and are left alone. The rest are generated
because each one exists to land on a specific code path at a specific length,
and a hand-typed file drifts off that path the moment somebody tidies it.
"""

import importlib.util
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
NOTES = HERE / "notes"

PARA = (
    "Планировщик живёт внутри приложения, поэтому пропущенные запуски догоняются "
    "при следующем старте, а не теряются насовсем. Это осознанное ограничение: "
    "никаких демонов и никаких хостед-раннеров. "
)


def write_fixtures():
    # 07 — body well over CHUNK_MAX across several sections, so the
    # accumulate-and-flush loop runs more than once. Every section is small
    # enough that the accumulator, not the per-chunk cap, decides the cuts.
    secs = "".join(f"## Секция {i}\n{PARA * 4}\n\n" for i in range(1, 6))
    (NOTES / "07-long-many-sections.md").write_text(f"# Длинная заметка\n\n{secs}")

    # 08 — over BIG_FILE (30 000 bytes) *with* a TL;DR, so only the TL;DR
    # survives and the head-excerpt branch is never reached.
    big = "".join(f"## Раздел {i}\n{PARA * 8}\n\n" for i in range(1, 30))
    (NOTES / "08-big-file.md").write_text(
        "# Очень большая заметка\n\n## TL;DR\n"
        "Файл больше тридцати килобайт, поэтому индексируется только эта секция.\n"
        "Остальное тело в индекс не попадает вовсе, и это ожидаемое поведение.\n\n"
        + big
    )

    # 09 — over BIG_FILE with *no* TL;DR, which is the only way to reach the
    # 1500-character head excerpt. Cyrillic throughout, so a cut counted in
    # bytes lands around character 750 instead of 1500 and the golden file
    # disagrees loudly.
    body = "".join(f"## Раздел {i}\n{PARA * 8}\n\n" for i in range(1, 30))
    (NOTES / "09-big-file-no-tldr.md").write_text(
        "# Большая заметка без TL;DR\n\n" + body
    )

    # 10 — under BIG_FILE, but with one section longer than CHUNK_MAX. The
    # accumulator cannot split inside a section, so that section becomes an
    # oversized chunk and the per-chunk cap is what truncates it. This is the
    # *only* fixture that reaches that cap: in 07 every chunk is already under
    # it when the accumulator flushes.
    (NOTES / "10-oversized-section.md").write_text(
        "# Заметка с огромной секцией\n\n"
        f"## Огромная секция\n{PARA * 15}\n\n"
        f"## Обычная секция\n{PARA * 2}\n"
    )

    # 11 — three byte-identical sections, and no `# ` title line so that no
    # title is prepended and the chunks come out identical rather than merely
    # similar. Without deduplication this file yields three copies of one
    # chunk; with it, one.
    repeated = f"## Повтор\n{PARA * 6}\n\n"
    (NOTES / "11-duplicate-sections.md").write_text(repeated * 3)


def load_reference():
    path = os.path.expanduser("~/.claude/bin/vault_index.py")
    if not os.path.exists(path):
        sys.exit(
            f"reference implementation not found at {path}.\n"
            "Without it there is nothing to be golden against — see the module "
            "docstring."
        )
    spec = importlib.util.spec_from_file_location("vault_index", path)
    vi = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vi)
    return vi


def main():
    write_fixtures()
    vi = load_reference()

    out = {}
    for p in sorted(NOTES.glob("*.md")):
        _project, chunks = vi.chunk_note(p.name, p.read_text())
        out[p.name] = chunks

    (HERE / "golden.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    )

    for p in sorted(NOTES.glob("*.md")):
        text = p.read_text()
        print(
            f"{p.name}: {len(text)} chars, {len(p.read_bytes())} bytes, "
            f"{len(out[p.name])} chunks"
        )


if __name__ == "__main__":
    main()
