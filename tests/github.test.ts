import { describe, it, expect } from "vitest";
import { installCommand, missingScopes, scopeWarning, accountChoices } from "../src/github";
import type { GhAccount, GhStatus } from "../src/ipc";

const acc = (over: Partial<GhAccount> = {}): GhAccount => ({
  host: "github.com", login: "followLemmi", active: false,
  scopes: ["gist", "read:org", "repo", "workflow"], state: "success", ...over,
});

describe("installCommand", () => {
  it("uses the native package manager per platform", () => {
    expect(installCommand({ os: "macos", distro: null })).toBe("brew install gh");
    expect(installCommand({ os: "windows", distro: null })).toBe("winget install --id GitHub.cli");
    expect(installCommand({ os: "linux", distro: "ubuntu" })).toBe("sudo apt install gh");
    expect(installCommand({ os: "linux", distro: "debian" })).toBe("sudo apt install gh");
    expect(installCommand({ os: "linux", distro: "fedora" })).toBe("sudo dnf install gh");
    expect(installCommand({ os: "linux", distro: "arch" })).toBe("sudo pacman -S github-cli");
    expect(installCommand({ os: "linux", distro: "opensuse-tumbleweed" }))
      .toBe("sudo zypper install gh");
  });

  it("falls back to the documented installer for unknown distros", () => {
    // Поле в UI редактируемое: угадывать наугад хуже, чем честно предложить доку.
    expect(installCommand({ os: "linux", distro: "voidlinux" }))
      .toBe("# см. https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
    expect(installCommand({ os: "linux", distro: null }))
      .toBe("# см. https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
  });
});

describe("missingScopes", () => {
  it("reports repo as missing when absent", () => {
    expect(missingScopes(acc())).toEqual([]);
    expect(missingScopes(acc({ scopes: ["gist"] }))).toEqual(["repo"]);
    expect(missingScopes(acc({ scopes: [] }))).toEqual(["repo"]);
  });
});

describe("scopeWarning", () => {
  it("warns in Russian only when something is missing", () => {
    expect(scopeWarning(acc())).toBeNull();
    expect(scopeWarning(acc({ scopes: ["gist"] })))
      .toBe("у аккаунта нет скоупа repo — приватные репозитории будут недоступны");
  });
});

describe("accountChoices", () => {
  const status = (accounts: GhAccount[]): GhStatus =>
    ({ path: "gh", version: "gh version 2.82.1", accounts });

  it("puts the unbound option first and marks the active account", () => {
    const choices = accountChoices(status([acc({ login: "a", active: true }), acc({ login: "b" })]));
    expect(choices[0]).toEqual({ value: "", label: "— не привязан —", missing: false });
    expect(choices[1].value).toBe("a");
    expect(choices[1].label).toBe("a (активный в gh)");
    expect(choices[2].label).toBe("b");
  });

  it("keeps a saved login that gh no longer knows, flagged as missing", () => {
    const choices = accountChoices(status([acc({ login: "a" })]), "gone");
    const stale = choices.find((c) => c.value === "gone");
    expect(stale).toBeDefined();
    expect(stale!.missing).toBe(true);
    expect(stale!.label).toBe("gone (не найден в gh)");
  });

  it("does not duplicate a saved login that gh still knows", () => {
    const choices = accountChoices(status([acc({ login: "a" })]), "a");
    expect(choices.filter((c) => c.value === "a")).toHaveLength(1);
  });

  it("offers only the unbound option when gh is absent", () => {
    expect(accountChoices({ path: null, version: null, accounts: [] })).toEqual([
      { value: "", label: "— не привязан —", missing: false },
    ]);
  });
});
