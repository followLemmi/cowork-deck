// Scenario prompts may contain {{name}} placeholders. At launch we collect a
// value per unique placeholder and substitute before sending the first message.
// NOTE: this module-level regex is shared and stateful (`g` flag tracks
// `lastIndex`). It's only safe here because `String.prototype.matchAll`
// operates on an internal clone of the regex, and `String.prototype.replace`
// resets `lastIndex` to 0 itself after each full pass. Do NOT call
// `RE.exec(...)` or `RE.test(...)` directly on this shared instance — that
// would leak `lastIndex` state across calls; use a fresh regex literal for
// those instead.
// `\w` is ASCII-only in JavaScript, so a non-ASCII name like {{ветка}} matched
// nothing: no field was offered and the braces went to claude verbatim. A
// prompt is written in whatever language its author thinks in — which the UI's
// own language does not constrain — so non-ASCII names are a normal case, not
// an edge one. Hence \p{L} and the `u` flag.
const RE = /\{\{\s*([\p{L}\p{N}_-]+)\s*\}\}/gu;

export function parsePlaceholders(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(RE)) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

export function fillPlaceholders(prompt: string, values: Record<string, string>): string {
  return prompt.replace(RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole);
}

/** A prompt with its placeholders filled in, and the values that filled them.
 *
 *  Both halves, because they answer different questions and the second one used
 *  to be thrown away. `prompt` is what the session is sent; `params` is what the
 *  run journal records, so a run can later be offered again with the values it
 *  actually used visible in the form. */
export interface ResolvedPrompt {
  prompt: string;
  params: Record<string, string>;
}

/** Resolve a prompt's placeholders. No placeholders → returns the prompt as-is
 *  without asking, with no values. Otherwise calls `ask` with the names; returns
 *  null if the user cancelled. */
export async function resolvePrompt(
  prompt: string,
  ask: (names: string[]) => Promise<Record<string, string> | null>,
): Promise<ResolvedPrompt | null> {
  const names = parsePlaceholders(prompt);
  if (names.length === 0) return { prompt, params: {} };
  const values = await ask(names);
  if (!values) return null;
  return { prompt: fillPlaceholders(prompt, values), params: values };
}
