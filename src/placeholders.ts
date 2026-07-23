// Scenario prompts may contain {{name}} placeholders. At launch we collect a
// value per unique placeholder and substitute before sending the first message.
const RE = /\{\{\s*([\w-]+)\s*\}\}/g;

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

/** Resolve a prompt's placeholders. No placeholders → returns the prompt as-is
 *  without asking. Otherwise calls `ask` with the names; returns the filled
 *  prompt, or null if the user cancelled. */
export async function resolvePrompt(
  prompt: string,
  ask: (names: string[]) => Promise<Record<string, string> | null>,
): Promise<string | null> {
  const names = parsePlaceholders(prompt);
  if (names.length === 0) return prompt;
  const values = await ask(names);
  if (!values) return null;
  return fillPlaceholders(prompt, values);
}
