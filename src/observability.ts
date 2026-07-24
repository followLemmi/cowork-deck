import type { TokenUsage } from "./ipc";

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
