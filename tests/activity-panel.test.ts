// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  activityButton,
  agentLabel,
  byServer,
  localRoll,
  openActivityPanel,
  outcomeSuffix,
  renderRoll,
  setActivityCount,
  unavailableSentence,
} from "../src/activity";
import type { ActivityRoll, AgentTally, ToolTally } from "../src/ipc";

beforeEach(() => { document.body.innerHTML = ""; });

function tool(native: string, calls: number, extra: Partial<ToolTally> = {}): ToolTally {
  return {
    native,
    category: native.startsWith("mcp__") ? "mcp" : "run",
    server: null,
    calls,
    errors: 0,
    denials: 0,
    ...extra,
  };
}

function agent(id: string, calls: number, extra: Partial<AgentTally> = {}): AgentTally {
  return {
    id,
    kind: "main",
    agentType: null,
    description: null,
    depth: 0,
    spawnedBy: null,
    tools: [tool("Bash", calls)],
    calls,
    ...extra,
  };
}

function roll(over: Partial<ActivityRoll> = {}): ActivityRoll {
  const tools = over.tools ?? [tool("Bash", 3)];
  return {
    cli: "claude",
    agents: over.agents ?? [agent("main", 3)],
    tools,
    calls: tools.reduce((n, t) => n + t.calls, 0),
    capabilities: { outcomes: true, agents: true },
    readAt: 1_700_000_000,
    unavailable: null,
    truncated: null,
    ...over,
  };
}

function draw(r: ActivityRoll): HTMLElement {
  const body = document.createElement("div");
  document.body.append(body);
  renderRoll(body, "a session", r, null);
  return body;
}

// --- the three empty states, which are three different sentences -------------

describe("the empty states", () => {
  const states = ["noLog", "notAnAgent", "noReader", "unreadable"] as const;

  it("each renders its own sentence, and none of them renders a zero", () => {
    const seen = new Set<string>();
    for (const why of states) {
      const body = draw(roll({ unavailable: why, tools: [], agents: [], calls: 0 }));
      const empty = body.querySelector<HTMLElement>(".act-empty--unavailable")!;
      expect(empty, why).toBeTruthy();
      expect(empty.dataset.state).toBe(why);
      expect(empty.textContent).not.toMatch(/\b0\b/);
      seen.add(empty.textContent ?? "");
    }
    // Four states, four sentences: a person told "no log" for a command tile
    // learns nothing about why.
    expect(seen.size).toBe(states.length);
  });

  it("names the CLI when the reason is that it has none", () => {
    const body = draw(roll({ cli: "codex", unavailable: "noReader", tools: [], agents: [], calls: 0 }));
    expect(body.querySelector(".act-empty")!.textContent).toContain("Codex CLI");
  });

  // The whole distinction this feature is drawn around. `SessionSnapshot` hides
  // the token badge rather than drawing four zeroes for the same reason.
  it("a roll with calls: 0 and a roll with unavailable do not render the same DOM", () => {
    const quiet = draw(roll({ tools: [], agents: [agent("main", 0)], calls: 0 }));
    const absent = draw(roll({ unavailable: "noLog", tools: [], agents: [], calls: 0 }));
    expect(quiet.querySelector(".act-empty--quiet")).toBeTruthy();
    expect(quiet.querySelector(".act-empty--unavailable")).toBeNull();
    expect(absent.querySelector(".act-empty--unavailable")).toBeTruthy();
    expect(absent.querySelector(".act-empty--quiet")).toBeNull();
    expect(quiet.innerHTML).not.toBe(absent.innerHTML);
  });

  it("says there have been no calls yet, rather than showing an empty table", () => {
    const body = draw(roll({ tools: [], agents: [agent("main", 0)], calls: 0 }));
    expect(body.querySelector(".act-empty--quiet")!.textContent).toBe("No tool calls yet.");
    expect(body.querySelector(".act-section--tools")).toBeNull();
  });
});

// --- outcomes ----------------------------------------------------------------

describe("errors and refusals", () => {
  it("are absent from a row that has neither", () => {
    const body = draw(roll({ tools: [tool("Bash", 5)] }));
    expect(body.querySelector(".act-row-outcome")).toBeNull();
  });

  it("are stated separately when there are any", () => {
    const body = draw(roll({ tools: [tool("Bash", 5, { errors: 2, denials: 1 })] }));
    const text = body.querySelector(".act-row-outcome")!.textContent ?? "";
    expect(text).toContain("2 errors");
    expect(text).toContain("1 refused");
  });

  it("phrases one of each in the singular", () => {
    expect(outcomeSuffix({ errors: 1, denials: 0 })).toBe("1 error");
    expect(outcomeSuffix({ errors: 0, denials: 0 })).toBe("");
  });

  // Driven by the capability, not by the data: a reader that cannot tell a
  // failure from a success would otherwise report zero of each, which reads as
  // "nothing failed".
  it("are omitted entirely for a reader that disclaims outcomes", () => {
    const r = roll({
      tools: [tool("bash", 5, { errors: 3 })],
      capabilities: { outcomes: false, agents: false },
    });
    const body = draw(r);
    expect(body.querySelector(".act-row-outcome")).toBeNull();
    expect(body.querySelector(".act-fact--bad")).toBeNull();
  });
});

// --- the sections ------------------------------------------------------------

describe("the by-MCP-server section", () => {
  it("is absent when there are no MCP calls", () => {
    expect(draw(roll({ tools: [tool("Bash", 3)] })).querySelector(".act-section--mcp")).toBeNull();
  });

  it("is present when there is one", () => {
    const r = roll({ tools: [tool("mcp__gitnexus__impact", 1, { server: "gitnexus" })] });
    const body = draw(r);
    expect(body.querySelector(".act-section--mcp")).toBeTruthy();
    expect(body.querySelector<HTMLElement>(".act-server")!.dataset.server).toBe("gitnexus");
  });

  // 13 of 26 distinct tool names measured were MCP across just two servers.
  // Without the grouping the tool list is a wall of one server's prefix.
  it("folds many names into one row per server, ordered by calls", () => {
    const rows = byServer([
      tool("mcp__a__one", 2, { server: "a" }),
      tool("mcp__b__one", 9, { server: "b" }),
      tool("mcp__a__two", 3, { server: "a" }),
      tool("Bash", 40),
    ]);
    expect(rows).toEqual([
      { server: "b", calls: 9, tools: 1 },
      { server: "a", calls: 5, tools: 2 },
    ]);
  });
});

describe("the by-agent section", () => {
  const delegated = () =>
    roll({
      tools: [tool("Bash", 9)],
      agents: [
        agent("main", 3),
        agent("agent-abc", 6, {
          kind: "subagent",
          agentType: "Code Reviewer",
          description: "Review PR #168",
          depth: 1,
          spawnedBy: "toolu_01",
        }),
      ],
    });

  it("shows a subagent as agentType — description", () => {
    const row = draw(delegated()).querySelector<HTMLElement>('.act-agent[data-agent="agent-abc"]')!;
    expect(row.querySelector(".act-agent-name")!.textContent).toBe("Code Reviewer — Review PR #168");
  });

  it("indents by depth, so a delegation reads as one", () => {
    const body = draw(delegated());
    const main = body.querySelector<HTMLElement>('.act-agent[data-agent="main"]')!;
    const sub = body.querySelector<HTMLElement>('.act-agent[data-agent="agent-abc"]')!;
    expect(main.style.getPropertyValue("--act-depth")).toBe("0");
    expect(sub.style.getPropertyValue("--act-depth")).toBe("1");
  });

  // A subagent whose metadata was missing keeps its calls and loses only its
  // name — the rule the reader follows, made visible.
  it("still shows the calls of a subagent whose metadata was missing", () => {
    const r = roll({
      tools: [tool("Bash", 8)],
      agents: [agent("main", 2), agent("agent-nameless", 6, { kind: "subagent", depth: 1 })],
    });
    const row = draw(r).querySelector<HTMLElement>('.act-agent[data-agent="agent-nameless"]')!;
    expect(row.querySelector(".act-agent-name")!.textContent).toBe("agent-nameless");
    expect(row.querySelector(".act-row-count")!.textContent).toBe("6");
    expect(agentLabel({ ...agent("x", 1), kind: "subagent" })).toBe("x");
  });

  it("is omitted for a reader whose log does not attribute delegated work", () => {
    const r = roll({ capabilities: { outcomes: true, agents: false } });
    expect(draw(r).querySelector(".act-section--agents")).toBeNull();
  });
});

describe("the head", () => {
  it("states the CLI, the calls and the distinct tools", () => {
    const body = draw(roll({ tools: [tool("Bash", 3), tool("Read", 1)] }));
    const facts = [...body.querySelectorAll(".act-fact")].map((n) => n.textContent);
    expect(facts).toContain("Claude Code");
    expect(facts).toContain("4 calls");
    expect(facts).toContain("2 tools");
  });

  it("reports a bounded read rather than absorbing it", () => {
    const body = draw(roll({ truncated: 500 }));
    expect(body.querySelector(".act-note")!.textContent).toContain("500 files");
    expect(draw(roll()).querySelector(".act-note")).toBeNull();
  });
});

// --- the button --------------------------------------------------------------

describe("the activity button", () => {
  it("hides the number when there is no reading, and shows a zero when there is", () => {
    const b = activityButton();
    expect(b.querySelector(".tile-activity-count")!.classList.contains("hidden")).toBe(true);
    setActivityCount(b, 0);
    expect(b.querySelector(".tile-activity-count")!.textContent).toBe("0");
    expect(b.getAttribute("aria-label")).toContain("0 tool calls");
    setActivityCount(b, null);
    expect(b.querySelector(".tile-activity-count")!.classList.contains("hidden")).toBe(true);
  });

  it("stays in the DOM either way, so it stays in the tab order", () => {
    const b = activityButton();
    setActivityCount(b, null);
    expect(b.isConnected).toBe(false); // not appended by this test
    expect(b.classList.contains("hidden")).toBe(false);
  });
});

// --- the dialog --------------------------------------------------------------

describe("openActivityPanel", () => {
  it("draws the roll it was handed before any read returns", () => {
    const panel = openActivityPanel({
      session: "s1",
      name: "a session",
      initial: localRoll("notAnAgent"),
    });
    expect(panel.body.querySelector(".act-empty")!.textContent)
      .toBe(unavailableSentence("notAnAgent", "claude"));
    panel.close();
  });

  it("closes on Escape", () => {
    const panel = openActivityPanel({ session: "s1", name: "n", initial: localRoll("noLog") });
    expect(document.querySelector(".modal-overlay")).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".modal-overlay")).toBeNull();
    panel.close();
  });

  it("repaints from a read, and reads once on open", async () => {
    const read = vi.fn().mockResolvedValue(roll({ tools: [tool("Bash", 7)] }));
    const panel = openActivityPanel({
      session: "s1", name: "n", initial: localRoll("noLog"), read,
    });
    await vi.waitFor(() => expect(panel.body.querySelector(".act-row")).toBeTruthy());
    expect(read).toHaveBeenCalledTimes(1);
    expect(panel.body.querySelector<HTMLElement>(".act-row")!.dataset.tool).toBe("Bash");
    panel.close();
  });

  // "Does not poll while closed" is the whole cost argument, so it is asserted
  // rather than assumed: the heaviest transcript measured is 3.1 MB, and a deck
  // of twelve re-reading every five seconds for a panel nobody opened is what
  // this feature is shaped to avoid.
  it("stops reading once it is closed", async () => {
    const read = vi.fn().mockResolvedValue(roll());
    const panel = openActivityPanel({
      session: "s1", name: "n", initial: localRoll("noLog"), read,
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await panel.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    panel.close();
    await panel.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("leaves the last good reading on screen when a read fails", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(roll({ tools: [tool("Bash", 7)] }))
      .mockRejectedValueOnce(new Error("gone"));
    const panel = openActivityPanel({
      session: "s1", name: "n", initial: localRoll("noLog"), read,
    });
    await vi.waitFor(() => expect(panel.body.querySelector(".act-row")).toBeTruthy());
    await panel.refresh();
    expect(panel.body.querySelector<HTMLElement>(".act-row")!.dataset.tool).toBe("Bash");
    panel.close();
  });

  it("does not read at all for a tile that has no log to read", async () => {
    const panel = openActivityPanel({ session: "s1", name: "n", initial: localRoll("notAnAgent") });
    await panel.refresh();
    expect(panel.body.querySelector(".act-empty")).toBeTruthy();
    panel.close();
  });
});
