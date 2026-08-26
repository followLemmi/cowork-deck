// The pure functions of the GitHub integration: they know nothing of the DOM and
// nothing of Tauri, which is what makes them wholly unit-testable. Everything that
// draws is in github-screen.ts.

import type { GhAccount, GhStatus, HostPlatform } from "./ipc";

const LINUX_DOC = "# see https://github.com/cli/cli/blob/trunk/docs/install_linux.md";

const APT = new Set(["ubuntu", "debian", "linuxmint", "pop", "raspbian"]);
const DNF = new Set(["fedora", "rhel", "centos", "rocky", "almalinux"]);
const PACMAN = new Set(["arch", "manjaro", "endeavouros"]);
const ZYPPER = new Set(["opensuse", "opensuse-tumbleweed", "opensuse-leap", "sles"]);

/** The install command for gh on this platform. The result goes into an EDITABLE
 *  field: working out the package manager is a heuristic, and the command will run
 *  under sudo — so the last word stays with the person running it. */
export function installCommand(p: HostPlatform): string {
  if (p.os === "macos") return "brew install gh";
  if (p.os === "windows") return "winget install --id GitHub.cli";
  const d = p.distro ?? "";
  if (APT.has(d)) return "sudo apt install gh";
  if (DNF.has(d)) return "sudo dnf install gh";
  if (PACMAN.has(d)) return "sudo pacman -S github-cli";
  if (ZYPPER.has(d)) return "sudo zypper install gh";
  return LINUX_DOC;
}

/** Scopes a bound account must carry.
 *
 *  `read:project` is deliberately absent, and the issues board depends on that:
 *  `projectCards` and `projectItems` fail an *entire* `gh issue list` request
 *  without it, so `ISSUE_LIST_FIELDS` (src-tauri/src/tasks/gh_issues.rs) must
 *  never ask for them while this list stays as it is. Widening this list is the
 *  first half of GitHub Projects support, not a free improvement. */
const REQUIRED_SCOPES = ["repo"];

/** The scopes without which private repositories are out of an account's reach. */
export function missingScopes(acc: GhAccount): string[] {
  return REQUIRED_SCOPES.filter((s) => !acc.scopes.includes(s));
}

export function scopeWarning(acc: GhAccount): string | null {
  const missing = missingScopes(acc);
  if (!missing.length) return null;
  return `this account is missing the ${missing.join(", ")} scope — private repositories will be out of reach`;
}

export interface AccountChoice { value: string; label: string; missing: boolean; }

/** The options for the select in the workspace form. A saved login that gh no
 *  longer knows about is NOT dropped: without it, editing any other field on the
 *  form would quietly take the binding down with it. */
export function accountChoices(status: GhStatus, savedLogin?: string | null): AccountChoice[] {
  const choices: AccountChoice[] = [{ value: "", label: "— not linked —", missing: false }];
  for (const a of status.accounts) {
    choices.push({
      value: a.login,
      label: a.active ? `${a.login} (active in gh)` : a.login,
      missing: false,
    });
  }
  if (savedLogin && !status.accounts.some((a) => a.login === savedLogin)) {
    choices.push({ value: savedLogin, label: `${savedLogin} (not found in gh)`, missing: true });
  }
  return choices;
}
