// @vitest-environment jsdom
/** The startup update check, untested until now (#463).
 *
 *  What is worth testing here is not the download — it is the four ways this
 *  must NOT get in the way of the session somebody came to start, and the one
 *  piece of memory that keeps a startup check from becoming an every-launch nag.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  confirmModal: vi.fn(),
  alertModal: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: m.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: m.relaunch }));
vi.mock("../src/modal", () => ({ confirmModal: m.confirmModal, alertModal: m.alertModal }));

import { offerUpdateIfAvailable } from "../src/updater";

const KEY = "updater:dismissed-version";

function update(over: Partial<{ version: string; currentVersion: string }> = {}) {
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
  return {
    u: { version: "0.6.0", currentVersion: "0.5.0", downloadAndInstall, ...over },
    downloadAndInstall,
  };
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  localStorage.clear();
  m.confirmModal.mockResolvedValue(false);
  m.alertModal.mockResolvedValue(undefined);
  /* A test run IS a dev build as far as `import.meta.env` is concerned, and the
     first line of the function under test returns on that — so every case below
     would pass by doing nothing. Stubbed to a release build here, and the guard
     itself is asserted in the one case that leaves it alone. */
  vi.stubEnv("DEV", false);
});

afterEach(() => { vi.unstubAllEnvs(); });

/** The reason the guard is the first line: a dev build reports whatever version
 *  `tauri.conf.json` carries, and would happily "update" itself to the released
 *  one on every reload. */
describe("a dev build", () => {
  it("does not even ask", async () => {
    vi.unstubAllEnvs();
    m.check.mockResolvedValue(update().u);
    await offerUpdateIfAvailable();
    expect(m.check).not.toHaveBeenCalled();
    expect(m.confirmModal).not.toHaveBeenCalled();
  });
});

describe("nothing to offer", () => {
  it("asks nobody anything when there is no newer version", async () => {
    m.check.mockResolvedValue(null);
    await offerUpdateIfAvailable();
    expect(m.confirmModal).not.toHaveBeenCalled();
  });
});

describe("a check that fails", () => {
  /** Unreachable is routine; a signature or config fault lands here too, and
   *  silence would hide that for good — so it is logged and then dropped. */
  it("is logged and never fatal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.check.mockRejectedValue(new Error("offline"));
    await expect(offerUpdateIfAvailable()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(m.confirmModal).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the offer", () => {
  it("names both versions, so the person knows what they are moving from", async () => {
    const { u } = update();
    m.check.mockResolvedValue(u);
    await offerUpdateIfAvailable();
    const asked = String(m.confirmModal.mock.calls[0][0]);
    expect(asked).toContain("0.6.0");
    expect(asked).toContain("0.5.0");
  });

  it("installs and then asks about the restart, in that order", async () => {
    const { u, downloadAndInstall } = update();
    m.check.mockResolvedValue(u);
    m.confirmModal.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await offerUpdateIfAvailable();
    expect(downloadAndInstall).toHaveBeenCalled();
    expect(m.relaunch).toHaveBeenCalled();
  });

  /** An installed update that takes effect on restart is not a reason to take the
   *  window away from somebody mid-session. */
  it("leaves the app running when the restart is declined", async () => {
    const { u, downloadAndInstall } = update();
    m.check.mockResolvedValue(u);
    m.confirmModal.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await offerUpdateIfAvailable();
    expect(downloadAndInstall).toHaveBeenCalled();
    expect(m.relaunch).not.toHaveBeenCalled();
  });
});

describe("what a decline remembers", () => {
  /** The whole point of the key: a startup check that asked again every launch
   *  would be a nag, and a person who said no said no about THIS version. */
  it("does not ask twice about the same version", async () => {
    const { u } = update();
    m.check.mockResolvedValue(u);
    m.confirmModal.mockResolvedValue(false);
    await offerUpdateIfAvailable();
    expect(localStorage.getItem(KEY)).toBe("0.6.0");

    m.confirmModal.mockClear();
    await offerUpdateIfAvailable();
    expect(m.confirmModal).not.toHaveBeenCalled();
  });

  it("asks again as soon as there is a newer one", async () => {
    localStorage.setItem(KEY, "0.6.0");
    m.check.mockResolvedValue(update({ version: "0.7.0" }).u);
    await offerUpdateIfAvailable();
    expect(m.confirmModal).toHaveBeenCalled();
  });
});

describe("an install that fails", () => {
  /** A broken artifact must not turn the check into a nag either — so the same
   *  key is written — and the person is told, because unlike a failed check this
   *  one happened while they were watching. */
  it("says so, and does not offer that version again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { u, downloadAndInstall } = update();
    downloadAndInstall.mockRejectedValue(new Error("bad signature"));
    m.check.mockResolvedValue(u);
    m.confirmModal.mockResolvedValueOnce(true);

    await expect(offerUpdateIfAvailable()).resolves.toBeUndefined();
    expect(m.alertModal).toHaveBeenCalled();
    // And it says where to get it by hand, because the app can no longer.
    expect(String(m.alertModal.mock.calls[0][0])).toContain("releases page");
    expect(localStorage.getItem(KEY)).toBe("0.6.0");
    expect(m.relaunch).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
