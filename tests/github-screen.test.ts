// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { ghStatusMock, hostPlatformMock } = vi.hoisted(() => ({
  ghStatusMock: vi.fn(),
  hostPlatformMock: vi.fn(),
}));
vi.mock("../src/ipc", () => ({
  ghStatus: ghStatusMock,
  hostPlatform: hostPlatformMock,
}));

import { openGithubScreen } from "../src/github-screen";

const acc = (over: Record<string, unknown> = {}) => ({
  host: "github.com", login: "followLemmi", active: false,
  scopes: ["gist", "repo"], state: "success", ...over,
});

function deckSpy() {
  const calls: { title: string; command: string; cwd: string }[] = [];
  return {
    calls,
    openCommandTile: (title: string, command: string, cwd: string) => {
      calls.push({ title, command, cwd });
    },
  };
}

const box = () => document.querySelector(".gh-screen") as HTMLElement;
const text = () => box().textContent ?? "";
const button = (label: string) =>
  [...box().querySelectorAll("button")].find((b) => b.textContent === label);

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  hostPlatformMock.mockResolvedValue({ os: "linux", distro: "ubuntu" });
});

describe("the GitHub screen — gh is installed", () => {
  beforeEach(() => {
    ghStatusMock.mockResolvedValue({
      path: "gh",
      version: "gh version 2.82.1",
      accounts: [acc({ login: "a", active: true }), acc({ login: "b", scopes: ["gist"] })],
      error: null,
    });
  });

  it("shows the version, the path and both accounts", async () => {
    await openGithubScreen(deckSpy());
    expect(text()).toContain("gh version 2.82.1");
    expect(box().querySelectorAll(".gh-acc-row")).toHaveLength(2);
    expect(text()).toContain("a · active in gh");
  });

  it("warns about the missing repo scope only on the account missing it", async () => {
    await openGithubScreen(deckSpy());
    const warns = box().querySelectorAll(".gh-acc-warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].textContent).toContain("missing the repo scope");
  });

  it("\"Add an account\" opens a tile running gh auth login in the workspace folder", async () => {
    const deck = deckSpy();
    await openGithubScreen(deck, "/work/proj");
    button("Add an account")!.click();
    expect(deck.calls).toEqual([
      { title: "signing in to GitHub", command: "gh auth login", cwd: "/work/proj" },
    ]);
    // the screen closes, so it does not cover the tile it just created
    expect(document.querySelector(".gh-screen")).toBeNull();
  });

  it("does not offer to install when gh is already there", async () => {
    await openGithubScreen(deckSpy());
    expect(button("Install")).toBeUndefined();
  });
});

describe("the GitHub screen — gh not found", () => {
  beforeEach(() => {
    ghStatusMock.mockResolvedValue({ path: null, version: null, accounts: [], error: null });
  });

  it("fills the platform's install command into an EDITABLE field", async () => {
    await openGithubScreen(deckSpy());
    const input = box().querySelector("input.modal-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("sudo apt install gh");
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
  });

  it("runs EXACTLY the command the person edited", async () => {
    const deck = deckSpy();
    await openGithubScreen(deck, "/work/proj");
    const input = box().querySelector("input.modal-input") as HTMLInputElement;
    input.value = "sudo apt install gh=2.82.1";
    button("Install")!.click();
    expect(deck.calls[0].command).toBe("sudo apt install gh=2.82.1");
    expect(deck.calls[0].title).toBe("installing gh");
  });

  it("links the instructions for whoever installs it themselves", async () => {
    await openGithubScreen(deckSpy());
    const link = box().querySelector("a.gh-link") as HTMLAnchorElement;
    expect(link.href).toContain("cli/cli");
    expect(link.rel).toBe("noreferrer");
  });
});

describe("the GitHub screen — resilience", () => {
  it("does not fall over, and says so, when asking gh failed", async () => {
    ghStatusMock.mockRejectedValue(new Error("boom"));
    await openGithubScreen(deckSpy());
    expect(text()).toContain("could not ask gh");
    expect(button("Read again")).toBeDefined();
  });

  it("\"Read again\" asks once more and picks up an account that has appeared", async () => {
    ghStatusMock.mockResolvedValueOnce({ path: "gh", version: "v", accounts: [], error: null });
    await openGithubScreen(deckSpy());
    expect(text()).toContain("No accounts");

    ghStatusMock.mockResolvedValueOnce({ path: "gh", version: "v", accounts: [acc()], error: null });
    button("Read again")!.click();
    await vi.waitFor(() => expect(text()).toContain("followLemmi"));
    expect(box().querySelectorAll(".gh-acc-row")).toHaveLength(1);
  });

  // An empty list over live accounts is what an old gh without --json looked
  // like: the listing failed and the UI said "no accounts". A failed listing
  // is not emptiness.
  it("shows the listing error instead of the no-accounts note", async () => {
    ghStatusMock.mockResolvedValue({
      path: "gh", version: "gh version 2.4.0", accounts: [],
      error: "unknown flag: --json",
    });
    await openGithubScreen(deckSpy());
    expect(text()).toContain("unknown flag: --json");
    expect(text()).not.toContain("No accounts");
  });

  it("a click on the backdrop closes the screen", async () => {
    ghStatusMock.mockResolvedValue({ path: "gh", version: "v", accounts: [], error: null });
    await openGithubScreen(deckSpy());
    const ov = document.querySelector(".modal-overlay") as HTMLElement;
    ov.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".gh-screen")).toBeNull();
  });
});
