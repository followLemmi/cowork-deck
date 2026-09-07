// The three formatters that were written twice each, and the units they take.
//
// Nothing here is interesting on its own. What made it worth one file is that the
// copies had drifted, and two of the three drifts were the kind that shows on
// screen or corrupts a reading (#463):
//
//   * `formatTokens` existed in `usage.ts` flooring to whole thousands and in
//     `observability.ts` using `toFixed(1)`, so ONE number was shown two ways —
//     the tile badge said `ctx 83.7k` where a limit row said `83k`. The `toFixed`
//     copy also had a real fault: 999 999 came out as `1000.0k`, a unit it had
//     not reached.
//   * `agoLabel` existed in `runs.ts` taking MILLISECONDS and in `sync-copy.ts`
//     taking SECONDS, with two different vocabularies. Two functions of the same
//     name, one of which is wrong by a factor of a thousand at the other's call
//     site, is a trap rather than a duplication.
//   * `plural` existed in `runs.ts` as an ago-phrase builder and in
//     `tray-panel.ts` as an actual pluraliser. Only the second is what the name
//     says; the first is now inside `agoLabel`, where its output was only ever
//     used.
//
// Every time here is in MILLISECONDS, because that is what `Date.now()` gives
// and a second unit is what the drift above was made of. A caller holding
// seconds — the sync state does, and says so — multiplies at the call site,
// where the conversion is visible.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Tokens, at the precision anybody reads them at.
 *
 *  Six or seven digits is a number nobody counts, so it is scaled — and **never
 *  rounded up to a value that has not been reached**. That is the rule the
 *  `usage.ts` copy had and the `observability.ts` copy did not, and it is why the
 *  arithmetic floors rather than calling `toFixed` on the quotient: 999 999 reads
 *  as `999.9k`, where `(n / 1000).toFixed(1)` gives `1000.0k` — a unit it has not
 *  reached, in a place where the difference between "nearly spent" and "spent" is
 *  what a person acts on.
 *
 *  **One decimal, and a bare `.0` dropped.** The decimal is what the tile badge
 *  has always shown (`ctx 83.6k`) and what the `usage.ts` copy threw away by
 *  flooring to whole thousands. Dropping `.0` is what keeps a CEILING readable:
 *  a limit is written round — 2 000 requests, 500 000 tokens — and `2.0k requests`
 *  is a stray zero where `2k requests` is the number. A live count is never round
 *  in practice, so it keeps its decimal without a second function to say so.
 */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const [value, unit] = n < 1_000_000
    ? [Math.floor(n / 100) / 10, "k"]
    : [Math.floor(n / 100_000) / 10, "M"];
  return Number.isInteger(value) ? `${value}${unit}` : `${value.toFixed(1)}${unit}`;
}

/** `n` with a unit, singular or plural. The plural is given rather than derived:
 *  "session is" / "sessions are" is not a suffix. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How long ago, in words, from two millisecond timestamps.
 *
 *  Relative rather than absolute, because the question a journal row and a sync
 *  line both answer is "how long ago" and a wall clock makes the reader do the
 *  subtraction.
 *
 *  **A future timestamp reads as "just now"** rather than "in 3 minutes". Clocks
 *  do move backwards — a DST change, an NTP correction — and a record claiming to
 *  be from the future is a distraction rather than information.
 *
 *  `beyondAWeek` is the one rule the two callers genuinely disagree about, so it
 *  is a parameter rather than a second function:
 *
 *  - `"date"` — the journal's. "37 days ago" is arithmetic nobody asked for, and
 *    a run from last month is looked up by when it happened.
 *  - `"days"` — the sync line's. It is the one number that says whether sync is
 *    working at all, and a sync broken for three weeks looks exactly like a
 *    working one until a disk dies; "21 days ago" is the whole point, and a date
 *    there would make the reader do the subtraction this function exists to save.
 */
export function agoLabel(
  at: number | null,
  now: number,
  beyondAWeek: "date" | "days" = "date",
): string {
  if (at === null) return "never";
  const d = now - at;
  if (d < MIN) return "just now";
  if (d < HOUR) return ago(Math.floor(d / MIN), "minute");
  if (d < DAY) return ago(Math.floor(d / HOUR), "hour");
  if (d < 7 * DAY || beyondAWeek === "days") return ago(Math.floor(d / DAY), "day");
  return new Date(at).toLocaleDateString();
}

function ago(n: number, unit: string): string {
  return `${plural(n, unit, `${unit}s`)} ago`;
}
