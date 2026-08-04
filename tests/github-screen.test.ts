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

describe("экран GitHub — gh установлен", () => {
  beforeEach(() => {
    ghStatusMock.mockResolvedValue({
      path: "gh",
      version: "gh version 2.82.1",
      accounts: [acc({ login: "a", active: true }), acc({ login: "b", scopes: ["gist"] })],
    });
  });

  it("показывает версию, путь и оба аккаунта", async () => {
    await openGithubScreen(deckSpy());
    expect(text()).toContain("gh version 2.82.1");
    expect(box().querySelectorAll(".gh-acc-row")).toHaveLength(2);
    expect(text()).toContain("a · активный в gh");
  });

  it("предупреждает про нехватку скоупа repo только у того аккаунта, где его нет", async () => {
    await openGithubScreen(deckSpy());
    const warns = box().querySelectorAll(".gh-acc-warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].textContent).toContain("нет скоупа repo");
  });

  it("«Добавить аккаунт» открывает тайл с gh auth login в каталоге воркспейса", async () => {
    const deck = deckSpy();
    await openGithubScreen(deck, "/work/proj");
    button("Добавить аккаунт")!.click();
    expect(deck.calls).toEqual([
      { title: "вход в GitHub", command: "gh auth login", cwd: "/work/proj" },
    ]);
    // экран закрывается, чтобы не перекрывать созданный тайл
    expect(document.querySelector(".gh-screen")).toBeNull();
  });

  it("не предлагает установку, когда gh уже есть", async () => {
    await openGithubScreen(deckSpy());
    expect(button("Установить")).toBeUndefined();
  });
});

describe("экран GitHub — gh не найден", () => {
  beforeEach(() => {
    ghStatusMock.mockResolvedValue({ path: null, version: null, accounts: [] });
  });

  it("подставляет команду установки под платформу в РЕДАКТИРУЕМОЕ поле", async () => {
    await openGithubScreen(deckSpy());
    const input = box().querySelector("input.modal-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("sudo apt install gh");
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
  });

  it("запускает ИМЕННО отредактированную пользователем команду", async () => {
    const deck = deckSpy();
    await openGithubScreen(deck, "/work/proj");
    const input = box().querySelector("input.modal-input") as HTMLInputElement;
    input.value = "sudo apt install gh=2.82.1";
    button("Установить")!.click();
    expect(deck.calls[0].command).toBe("sudo apt install gh=2.82.1");
    expect(deck.calls[0].title).toBe("установка gh");
  });

  it("даёт ссылку на инструкцию для тех, кто ставит сам", async () => {
    await openGithubScreen(deckSpy());
    const link = box().querySelector("a.gh-link") as HTMLAnchorElement;
    expect(link.href).toContain("cli/cli");
    expect(link.rel).toBe("noreferrer");
  });
});

describe("экран GitHub — устойчивость", () => {
  it("не падает и объясняет, если опрос gh сорвался", async () => {
    ghStatusMock.mockRejectedValue(new Error("boom"));
    await openGithubScreen(deckSpy());
    expect(text()).toContain("не удалось опросить gh");
    expect(button("Перечитать")).toBeDefined();
  });

  it("«Перечитать» повторяет опрос и подхватывает появившийся аккаунт", async () => {
    ghStatusMock.mockResolvedValueOnce({ path: "gh", version: "v", accounts: [] });
    await openGithubScreen(deckSpy());
    expect(text()).toContain("Аккаунтов нет");

    ghStatusMock.mockResolvedValueOnce({ path: "gh", version: "v", accounts: [acc()] });
    button("Перечитать")!.click();
    await vi.waitFor(() => expect(text()).toContain("followLemmi"));
    expect(box().querySelectorAll(".gh-acc-row")).toHaveLength(1);
  });

  it("клик по фону закрывает экран", async () => {
    ghStatusMock.mockResolvedValue({ path: "gh", version: "v", accounts: [] });
    await openGithubScreen(deckSpy());
    const ov = document.querySelector(".modal-overlay") as HTMLElement;
    ov.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".gh-screen")).toBeNull();
  });
});
