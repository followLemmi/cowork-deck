/** The decisions the limits block, the dialog and the limit notification all
 *  have to agree on — and none of them knows the name of a provider.
 *
 *  Pure: no DOM, no IPC, no timers, so every rule in here is unit-tested as a
 *  rule. Three surfaces draw from one snapshot, and a rule about which window a
 *  row shows is a rule that must not be written twice — which is what happened
 *  when the floating pill carried its own copy of the shorter reset format
 *  (#394 removed it, and the copy with it).
 */

import type { AiUsage, LimitState, LimitWindow, UsageSource } from "./ipc";
import { formatTokens } from "./format";

/** Which window a one-line row should draw.
 *
 *  A provider has two or three, and a row has space for one. The order is by how
 *  much the answer changes what a person does next: a refusal first, then a
 *  window that is nearly spent, then whichever is fullest, and only then the
 *  declared order. Nothing chooses a window with no reading over one with a
 *  reading — an `unknown` row is what you get when they are all unknown, which is
 *  a true thing to draw and not a fallback.
 */
export function primaryWindow(u: AiUsage): LimitWindow | null {
  if (!u.windows.length) return null;
  return [...u.windows].sort(byUrgency)[0];
}

/** How much a window's answer changes what a person does next. Lower is more
 *  urgent.
 *
 *  Written once and used twice, which is the point: `primaryWindow` ranks the
 *  windows of one AI and `usageGlance` ranks the AIs against each other, and if
 *  those two used different ideas of "worst" the strip would name an AI that is
 *  not the one at the top of the list it opens. A snapshot with no windows at all
 *  ranks behind one that at least knows it does not know. */
function urgency(w: LimitWindow | null): number {
  if (!w) return 4;
  if (w.state === "exhausted") return 0;
  if (w.state === "near") return 1;
  if (w.usedFraction !== null || w.amount !== null) return 2;
  return 3;
}

/** Most urgent first, and within a rank the fuller one. `?? -1` keeps a window
 *  with no share behind one that has any share at all, including zero. */
function byUrgency(a: LimitWindow | null, b: LimitWindow | null): number {
  const r = urgency(a) - urgency(b);
  if (r !== 0) return r;
  return (b?.usedFraction ?? -1) - (a?.usedFraction ?? -1);
}

/** What the one line in the top bar says, out of every connected AI at once.
 *
 *  One AI is named and the rest are counted, because the question a glance asks
 *  is "can I keep working" and that is answered by whichever AI is worst off —
 *  the others cannot make the answer better. The count is there so the line never
 *  reads as the whole truth: `+3` is what says there is a list behind it.
 *
 *  The two counts beside it are the only thing about the others that changes the
 *  answer. Everything else about them is one press away. */
export interface UsageGlance {
  /** The AI the line names: the worst off of them. */
  snap: AiUsage;
  /** Its primary window — the same one its own row draws. `null` when the
   *  provider declared none, which is a state and not an error. */
  window: LimitWindow | null;
  /** How many AIs are connected and not named here. */
  others: number;
  /** Of those, how many are nearly spent, and how many are refusing work. */
  othersNear: number;
  othersSpent: number;
}

/** One AI and the window its row draws, as `rankedAis` pairs them. */
export interface RankedAi {
  snap: AiUsage;
  /** `null` when the provider declared no window at all, which is a state and
   *  not an error. */
  window: LimitWindow | null;
}

/* --- The lineup of dials -------------------------------------------------
   One dial per AI, in a FIXED order, which is the half of this that is not
   about data. `rankedAis` below orders by urgency and that is right for a list
   you read top to bottom; it is wrong for a row of three marks you learn the
   position of. A dial that moved when a quota moved would cost a person the one
   thing a row of marks buys them — knowing where to look before they look. */

/** An AI this deck draws a dial for, whether or not it can say anything yet.
 *
 *  `soon` is the deliberate part. Two of these are on the strip before they
 *  work: a locked dial says the shape of what is coming, and an app that simply
 *  omitted them would be indistinguishable from one that never intends to have
 *  them. It is a claim about the roadmap and not about the machine — so it does
 *  NOT move when a provider is installed, and a `soon` brand is never asked for
 *  a reading even when the backend has one. See `dialLineup`. */
export interface Brand {
  provider: string;
  label: string;
  soon: boolean;
}

/** The three, left to right. Claude answers; the other two are held. */
export const BRANDS: readonly Brand[] = [
  { provider: "claude", label: "Claude", soon: false },
  { provider: "codex", label: "Codex", soon: true },
  { provider: "gemini", label: "Gemini", soon: true },
];

/** One dial, with everything drawn on it already decided. */
export interface Dial {
  provider: string;
  label: string;
  /** `null` for a held brand, and for one this machine has nothing for. */
  snap: AiUsage | null;
  /** What the ring around the mark fills to. `null` draws a bare track — see
   *  `ringWindow` and `meterFraction`. */
  ring: LimitWindow | null;
  /** The state of the worst window the RING is not already showing, when that
   *  state is worth a mark of its own. `null` the rest of the time. */
  alert: LimitState | null;
  soon: boolean;
}

/** The window the ring draws: the long one.
 *
 *  A ring is the shape of a period coming round again, and the period worth
 *  drawing is the one a person plans against — the week, not the five hours.
 *  The five hours is the more urgent number and it is not lost: it is the first
 *  thing in the popover, and a five-hour window in trouble puts the alert mark
 *  on the dial (`dialAlert`).
 *
 *  Chosen by id where a provider declares a `week`, and otherwise the LAST
 *  window it declared. Both providers in the tree today list their windows
 *  shortest first — session then week, requests-per-minute then requests-per-day
 *  — so the last is the widest, and this file has no table of provider names to
 *  consult instead. `null` where a provider declared none at all. */
export function ringWindow(u: AiUsage): LimitWindow | null {
  return u.windows.find((w) => w.id === "week") ?? u.windows[u.windows.length - 1] ?? null;
}

/** What is wrong that the ring is not saying, or `null`.
 *
 *  The ring shows the week. A session window that is nearly spent is the fact
 *  that stops work in the next ten minutes, and a dial that drew a comfortable
 *  62% while the deck was about to be refused would be answering the question
 *  nobody asked. So the worst of the OTHER windows gets a mark of its own, and
 *  only when it is bad enough to act on. */
export function dialAlert(u: AiUsage, ring: LimitWindow | null): LimitState | null {
  const worst = u.windows.filter((w) => w !== ring).sort(byUrgency)[0];
  if (!worst) return null;
  return worst.state === "exhausted" || worst.state === "near" ? worst.state : null;
}

/** The row of dials, in the order they are drawn.
 *
 *  The three brands always, held ones included, and then anything the backend
 *  reported that is not among them. That tail is not decoration: the registry
 *  is provider-agnostic on purpose (#308), so a provider added in Rust must
 *  reach the screen without this file learning its name — and a lineup that
 *  only ever drew its own three would silently swallow it. */
export function dialLineup(snaps: AiUsage[]): Dial[] {
  const found = new Map(snaps.map((s) => [s.provider, s]));
  const named = new Set(BRANDS.map((b) => b.provider));
  const held = BRANDS.map((b) =>
    // A held brand is drawn from the roadmap and not from the machine, so its
    // snapshot is dropped on the floor even when there is one. Gemini has a
    // provider in Rust that can answer nothing without a credential this app
    // will not take; drawing its permanent row of unknowns as though it were a
    // live reading is worse than saying plainly that it is not ready.
    dialOf(b.provider, b.label, b.soon ? null : found.get(b.provider) ?? null, b.soon),
  );
  const rest = snaps
    .filter((s) => !named.has(s.provider))
    .map((s) => dialOf(s.provider, s.label, s, false));
  return [...held, ...rest];
}

function dialOf(provider: string, label: string, snap: AiUsage | null, soon: boolean): Dial {
  const ring = snap ? ringWindow(snap) : null;
  return {
    provider,
    // The provider's own words for itself where there is a snapshot, so a
    // relabelled account is not overruled by this file's table.
    label: snap?.label ?? label,
    snap,
    ring,
    alert: snap ? dialAlert(snap, ring) : null,
    soon,
  };
}

/** Every connected AI, worst off first.
 *
 *  The one ordering both surfaces take, and that is the point of it being a
 *  function rather than a sort written twice: the strip names the first of these
 *  and the list is drawn in this order, so pressing the strip opens a list topped
 *  by the AI the strip just named. Ranked in the order they were DETECTED, the
 *  two agreed only by luck — an exhausted AI found last sat at the bottom of a
 *  list capped at 15rem, below the fold, while the strip pointed at it. */
export function rankedAis(snaps: AiUsage[]): RankedAi[] {
  return snaps
    .map((snap) => ({ snap, window: primaryWindow(snap) }))
    .sort((a, b) => byUrgency(a.window, b.window));
}

export function usageGlance(snaps: AiUsage[]): UsageGlance | null {
  const [worst, ...rest] = rankedAis(snaps);
  if (!worst) return null;
  return {
    snap: worst.snap,
    window: worst.window,
    others: rest.length,
    // A snapshot's primary window is its most urgent one, so an AI with anything
    // exhausted anywhere is counted here — no need to look past the primary.
    othersNear: rest.filter((r) => r.window?.state === "near").length,
    othersSpent: rest.filter((r) => r.window?.state === "exhausted").length,
  };
}

/** What the whole deck is up against, out of every provider at once. */
export interface DeckLimit {
  /** Whether anything is refusing work right now. */
  exhausted: boolean;
  /** When work becomes possible again, or `null` when that is not known.
   *
   *  The **latest** of the exhausted windows, not the earliest: a session window
   *  that lifts at 16:00 while the weekly one lifts on Sunday means Sunday. And
   *  one exhausted window with no known reset makes the whole answer `null`,
   *  because a time this app cannot stand behind is worse than no time. */
  resetsAt: number | null;
  /** Which AI is out, for a sentence that has to name it. `null` when more than
   *  one is — at which point naming one of them would be misleading. */
  provider: string | null;
}

export function deckLimit(snaps: AiUsage[]): DeckLimit {
  const out: DeckLimit = { exhausted: false, resetsAt: null, provider: null };
  const stuck = snaps.filter((s) => s.windows.some((w) => w.state === "exhausted"));
  if (!stuck.length) return out;
  out.exhausted = true;
  out.provider = stuck.length === 1 ? stuck[0].label : null;
  let latest: number | null = null;
  for (const s of stuck) {
    for (const w of s.windows) {
      if (w.state !== "exhausted") continue;
      if (w.resetsAt === null) return { ...out, resetsAt: null };
      latest = latest === null ? w.resetsAt : Math.max(latest, w.resetsAt);
    }
  }
  return { ...out, resetsAt: latest };
}

/** The class a state paints with.
 *
 *  Three, and healthy is deliberately not one of them: green already means
 *  "working" on every rail in this window, so spending it on "your quota is
 *  fine" would make a deck of healthy meters read as activity. A healthy window
 *  is neutral, and that is the design system's rule about hue belonging to state
 *  applied rather than bent — see `docs/design/slate-ember`. */
export function stateClass(state: LimitState): string {
  switch (state) {
    case "exhausted":
      return "lim-out";
    case "near":
      return "lim-near";
    default:
      return "lim-fine";
  }
}

/** What a ROW says about where its number came from, or `null` when it needs to
 *  say nothing.
 *
 *  ADR-0009 decision 1 required the tier beside every reading, in every row, in
 *  the tier's own name — "Reported", "Observed". The person who wrote that
 *  record then read `Claude · REPORTED · 29% used` in the status-area panel and
 *  asked what the word meant, which is as clear a verdict on a label as there
 *  is. The record is amended rather than abandoned; this function is the
 *  amendment, and the reasoning is there.
 *
 *  Two changes, and the second is what makes the first safe:
 *
 *  1. **The strongest tier says nothing.** An unqualified number is the
 *     account's own figure, which is what a person assumes anyway — and the
 *     failure ADR-0009 exists to prevent is the other direction: this app's own
 *     narrower count being read as the account's. Labelling only the weaker
 *     tiers prevents exactly that, and stops spending a quarter of a 340px row
 *     on a word that changes nothing.
 *  2. **The weaker tiers say what they mean, not what they are called.**
 *     "Observed" is the tier's name; "this app only" is the fact a person can
 *     act on. The names live on in the dialog, next to the sentence that
 *     defines them (`sourceExplanation`) — that is where a vocabulary is taught,
 *     and a row is not.
 *
 *  `unknown` also says nothing, because `readingOf` has already said "no
 *  reading" and two ways of saying nothing read as two facts — the same rule
 *  `limitFoot` keeps about an absent reset.
 */
export function tierNote(w: LimitWindow): string | null {
  switch (w.source) {
    case "reported":
      return null;
    case "observed":
      return "this app only";
    case "estimated":
      return "estimate";
    default:
      // Not reachable from any provider today: a window with no quantity is
      // where `unknown` comes from. Kept honest rather than assumed — a source
      // that says it does not know, over a number, is worth printing.
      return w.usedFraction === null && w.amount === null ? null : "source not known";
  }
}

/** What to call a tier by name, for the dialog. One word, and there it is always
 *  shown — the dialog is where the vocabulary is defined, beside
 *  `sourceExplanation`. A ROW uses `tierNote` instead; see the note there. */
export function sourceLabel(source: UsageSource): string {
  switch (source) {
    case "reported":
      return "Reported";
    case "observed":
      return "Observed";
    case "estimated":
      return "Estimated";
    default:
      return "Unknown";
  }
}

/** What a tier means, for the dialog. The provider's own caveat goes beside
 *  this, not instead of it: this sentence is about the tier and that one is
 *  about the number. */
export function sourceExplanation(source: UsageSource): string {
  switch (source) {
    case "reported":
      return "The account's own accounting — the same figure its own usage command draws.";
    case "observed":
      return "What this app can see for itself, from the sessions it runs.";
    case "estimated":
      return "Worked out from something adjacent, not measured.";
    default:
      return "Nothing is known about this window. That is not the same as nothing being spent.";
  }
}

/** A reset time as a person reads a clock, and no more precision than that.
 *
 *  Today's resets are a time; anything further out carries the day, because
 *  "19:00" on a Wednesday five days away is a sentence that reads as tonight.
 *  Local time throughout — the window is local to the person, not to a server. */
export function formatReset(at: number, now: number): string {
  const d = new Date(at);
  const clock = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return clock;
  const tomorrow = new Date(now + 24 * 60 * 60 * 1000);
  if (tomorrow.toDateString() === d.toDateString()) return `tomorrow ${clock}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${clock}`;
}

/** The one line a row shows beside its meter: the reading, in whatever terms the
 *  window has. A share where there is one, an absolute where there is not, and
 *  the honest blank where there is neither. */
export function readingOf(w: LimitWindow): string {
  if (w.usedFraction !== null) return `${Math.round(w.usedFraction * 100)}% used`;
  if (w.amount !== null) {
    const used = formatTokens(w.amount.used);
    return w.amount.limit === null
      ? `${used} ${w.amount.unit}`
      : `${used} of ${formatTokens(w.amount.limit)} ${w.amount.unit}`;
  }
  return "no reading";
}

/** How much of the meter to fill.
 *
 *  `null` means **draw no meter at all**, and it is the answer whenever there is
 *  no share — an absolute with no ceiling cannot fill a bar, and a bar drawn at
 *  some arbitrary width would be this app inventing a denominator. An exhausted
 *  window fills, because being refused is the one case where "full" is known
 *  without a number. */
export function meterFraction(w: LimitWindow): number | null {
  if (w.usedFraction !== null) return Math.max(0, Math.min(1, w.usedFraction));
  if (w.state === "exhausted") return 1;
  return null;
}

/** The line under a reading: what the state means, in a sentence.
 *
 *  Extracted from the limits block when the tray menu needed the same sentence.
 *  It is the same rule as `readingOf` and for the same reason — the block, the
 *  tray and anything after them must not each have their own opinion about what
 *  "exhausted with no known reset" reads as. A row saying one thing in the panel
 *  and another in the menu bar is the bug the pure helpers in this file exist to
 *  prevent. `usage-dial.ts` adds the tone and drops the sentence where its
 *  surface has no room for it; the words are all decided here.
 *
 *  Three states worth a sentence and one that is not:
 *
 *  - **Spent.** When it lifts, or that nobody said. The whole answer to "can I
 *    keep working" is here and nowhere else.
 *  - **Nearly spent.** Said in words as well as in a hue, because a difference
 *    carried by hue alone is one a person who cannot see the hue does not get.
 *    The reset when there is one and the ERROR when there is not: an error
 *    arrives beside the windows rather than instead of them, so a near reading
 *    and "token expired" can be true at once, and a reading nobody can refresh
 *    is worth less than the reason why.
 *  - **Working, with a known reset.** The time, plainly.
 *
 *  `null` is a row with nothing to add: the reading beside it already said
 *  everything. An unknown row deliberately does NOT get "not known" here — that
 *  repeats the reading, and two ways of saying nothing read as two facts.
 */
export function limitFoot(w: LimitWindow, error: string | null, now: number): string | null {
  if (w.state === "exhausted") {
    return w.resetsAt === null
      ? "nothing moves — no reset time known"
      : `nothing moves until ${formatReset(w.resetsAt, now)}`;
  }
  if (w.state === "near") {
    const why = w.resetsAt !== null ? `resets ${formatReset(w.resetsAt, now)}` : error;
    return why ? `nearly spent — ${why}` : "nearly spent";
  }
  if (w.resetsAt !== null) return `resets ${formatReset(w.resetsAt, now)}`;
  return error;
}

/* --- Telling somebody who is not looking at the window -------------------- */

/** One notification per transition, for the whole deck.
 *
 *  Twelve sessions stall on one ceiling, and twelve notifications about one
 *  ceiling is the bug this exists to prevent — so the state is held here, once,
 *  rather than being derived per session.
 *
 *  The reset is the more useful of the two and the one nothing else can tell you:
 *  you can work again. It fires **only** if this app saw the exhaustion, which
 *  falls out of the transition rather than needing a flag — a notification about
 *  something a person never saw happen is a notification about nothing.
 */
export interface LimitNotice {
  title: string;
  body: string;
}

export class LimitNotifier {
  private out = false;

  /** The notice this change deserves, or `null`. Call it with every snapshot;
   *  repeated identical states are silent. */
  next(limit: DeckLimit, now = Date.now()): LimitNotice | null {
    const was = this.out;
    this.out = limit.exhausted;
    if (limit.exhausted && !was) {
      const who = limit.provider ? `${limit.provider}: ` : "";
      return {
        title: "cowork-deck · limit reached",
        body:
          limit.resetsAt === null
            ? `${who}nothing will move, and no reset time is known.`
            : `${who}nothing will move until ${formatReset(limit.resetsAt, now)}.`,
      };
    }
    if (!limit.exhausted && was) {
      return {
        title: "cowork-deck · you can work again",
        body: "The limit has reset.",
      };
    }
    return null;
  }
}
