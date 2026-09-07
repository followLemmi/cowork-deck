import { formatTokens } from "./format";
import type { SessionTokens, TokenUsage } from "./ipc";

/** Everything billed on the way in. With prompt caching on, `input` alone is the
 *  uncached delta of each request — a couple of tokens — so it describes nothing
 *  by itself; the prompt is accounted under the two cache fields. */
export function spendIn(u: TokenUsage): number {
  return u.input + u.cacheCreation + u.cacheRead;
}

/** The badge shows one number, the context window, because that is the one worth
 *  reading at a glance. The bill lives here. */
export function tokenTooltip(t: SessionTokens): string {
  const lines = [
    `spend · ${formatTokens(t.spend.output)} out · ${formatTokens(spendIn(t.spend))} in`,
    `cache · ${formatTokens(t.spend.cacheRead)} read · ${formatTokens(t.spend.cacheCreation)} written`,
  ];
  // Worth stating only when there were any: a session whose spend is mostly
  // delegated is otherwise inexplicable from its context figure alone.
  if (t.subagents > 0) {
    lines.push(`subagents · ${t.subagents}`);
  }
  return lines.join("\n");
}

/** What the badge reads.
 *
 *  Labelled rather than bare: the badge sits beside a branch name, where a lone
 *  `83.7k` says nothing about which of a session's several token figures it is.
 *  A word rather than a glyph because the sibling git badge draws real SVG from
 *  `icons.ts`, and a single geometric codepoint next to it would be at the mercy
 *  of whatever the platform font has.
 *
 *  An em dash rather than a zero while the session has yet to make a request —
 *  it has no window, which is not a window of nothing. */
export function formatContext(context: number | null): string {
  return context === null ? "ctx —" : `ctx ${formatTokens(context)}`;
}

export function sumUsage(list: TokenUsage[]): TokenUsage {
  return list.reduce(
    (a, u) => ({
      input: a.input + u.input,
      output: a.output + u.output,
      cacheCreation: a.cacheCreation + u.cacheCreation,
      cacheRead: a.cacheRead + u.cacheRead,
    }),
    { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
  );
}

export function uniqueCwds(items: { cwd: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { cwd } of items) if (!seen.has(cwd)) { seen.add(cwd); out.push(cwd); }
  return out;
}
