/** The pull request list's read half, tested without booting the app.
 *
 *  The symmetric half of `tests/board-controller.test.ts`, and the cases are
 *  deliberately not the same ones (#463): the audit called this view "almost a
 *  copy of the board's poll loop", and now that the loop is shared outright
 *  (`poll.ts`) what is left differs in three ways worth pinning.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ prList: vi.fn() }));
vi.mock("../src/ipc", async (orig) => ({ ...(await orig() as object), ...m }));

import { PrController, type PrControllerHost } from "../src/pr-controller";
import type { PrState } from "../src/pr-view";
import type { PullRequest, Workspace } from "../src/ipc";

function ws(id: string, github = true): Workspace {
  return {
    id, name: id, path: `/w/${id}`, color: "#fff",
    github: github ? { host: "github.com", login: "me" } : undefined,
  } as unknown as Workspace;
}

function pr(n: number): PullRequest {
  return { number: n, title: `pr ${n}`, headRefOid: "abc" } as unknown as PullRequest;
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];

function host(active: Workspace | null) {
  const rendered: PrState[] = [];
  const polled: PullRequest[][] = [];
  let current = active;
  const h: PrControllerHost = {
    workspaces: { get active() { return current; } },
    prView: { render: (s: PrState) => { rendered.push({ ...s }); } },
    onPolled: (prs) => { polled.push(prs); },
  };
  return { h, rendered, polled, switchTo: (w: Workspace | null) => { current = w; } };
}

beforeEach(() => {
  m.prList.mockReset();
  m.prList.mockResolvedValue([]);
});

describe("the two states that cannot change on their own", () => {
  /** Nothing will change without a human editing a workspace — but both still
   *  have to stop the previous state polling, which is why they render rather
   *  than return early. */
  it("no workspace reads as no account", async () => {
    const { h, rendered } = host(null);
    await new PrController(h).read();
    expect(last(rendered)).toMatchObject({ workspace: null, unavailable: "no-account", prs: [] });
  });

  it("a workspace with no account bound says so, and keeps the workspace's name", async () => {
    const { h, rendered } = host(ws("a", false));
    await new PrController(h).read();
    expect(last(rendered)).toMatchObject({ workspace: "a", unavailable: "no-account" });
  });
});

describe("the skeleton", () => {
  /** A poll tick every 15 s keeps the rows it already has, with the age line
   *  above saying how old they are. Grey boxes every tick is a flicker. */
  it("is painted on a first read and not on the next", async () => {
    const { h, rendered } = host(ws("a"));
    const c = new PrController(h);
    await c.read();
    expect(rendered.filter((r) => r.loading)).toHaveLength(1);
    await c.read();
    expect(rendered.filter((r) => r.loading)).toHaveLength(1);
  });

  it("is painted again after a switch", async () => {
    const { h, rendered, switchTo } = host(ws("a"));
    const c = new PrController(h);
    await c.read();
    switchTo(ws("b"));
    await c.read();
    expect(rendered.filter((r) => r.loading)).toHaveLength(2);
  });
});

describe("`showing` is not derivable from the state", () => {
  /** The case that matters most, and the reason the field exists: a FIRST read
   *  that fails leaves `workspace` set and `fetchedAt` null, so a rule pairing
   *  those two would blank the error — or the unavailable box and its only
   *  button — for grey boxes on every tick from then on, and put it back. */
  it("so a first read that failed is not re-skeletoned on every tick", async () => {
    const { h, rendered } = host(ws("a"));
    const c = new PrController(h);
    m.prList.mockRejectedValue(new Error("rate limited"));
    await c.read();
    expect(last(rendered)).toMatchObject({ error: "rate limited", fetchedAt: null });
    const before = rendered.filter((r) => r.loading).length;
    await c.read();
    expect(rendered.filter((r) => r.loading).length).toBe(before);
    expect(last(rendered).error).toBe("rate limited");
  });
});

describe("a failure", () => {
  /** Known unavailabilities become their own screen; everything else keeps the
   *  last good list on screen beside the error with its age — and the list lives
   *  IN the state, which is why this view needs no cache where the board does. */
  it("keeps the rows that are on screen, with the error beside them", async () => {
    const { h, rendered } = host(ws("a"));
    const c = new PrController(h);
    m.prList.mockResolvedValue([pr(1), pr(2)]);
    await c.read();
    m.prList.mockRejectedValue(new Error("offline"));
    await c.read();
    expect(last(rendered).prs.map((p: PullRequest) => p.number)).toEqual([1, 2]);
    expect(last(rendered).error).toBe("offline");
  });

  /** The mapping is `issues.ts`'s and is read by the board too: it used to be an
   *  if-chain here, which was one place for the two GitHub views to disagree
   *  about what "no repository" looks like. */
  it("becomes its own screen where the message names one", async () => {
    const { h, rendered } = host(ws("a"));
    m.prList.mockRejectedValue(new Error("no git remotes found"));
    await new PrController(h).read();
    expect(last(rendered).unavailable).toBe("no-repo");
    expect(last(rendered).error).toBeNull();
  });
});

describe("a reply that arrives after a switch", () => {
  it("is discarded, and the drawer is never told about it", async () => {
    const { h, rendered, polled, switchTo } = host(ws("a"));
    const c = new PrController(h);
    let release: ((v: PullRequest[]) => void) | null = null;
    m.prList.mockImplementation(() => new Promise((r) => { release = r; }));
    const pending = c.read();
    for (let i = 0; i < 4 && release === null; i++) await Promise.resolve();
    switchTo(ws("b"));
    release!([pr(9)]);
    await pending;
    expect(rendered.some((r) => r.prs.length > 0)).toBe(false);
    expect(polled).toEqual([]);
  });
});

describe("the total", () => {
  /** What came back and nothing more: `pr_list` asks for one page, so how many
   *  open pull requests the repository has is not knowable from here (#115). */
  it("is the page's own length, never a claim about the repository", async () => {
    const { h, rendered } = host(ws("a"));
    m.prList.mockResolvedValue([pr(1), pr(2), pr(3)]);
    await new PrController(h).read();
    expect(last(rendered).total).toBe(3);
  });
});

describe("the rows the poll reads its interval from", () => {
  /** A list of thirty is worth asking about less often than a list of three. Read
   *  off the controller rather than held by the caller, so there is one copy. */
  it("are the state's own", async () => {
    const { h } = host(ws("a"));
    const c = new PrController(h);
    m.prList.mockResolvedValue([pr(1), pr(2)]);
    await c.read();
    expect(c.prs.map((p) => p.number)).toEqual([1, 2]);
  });
});
