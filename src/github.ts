// Чистые функции GitHub-интеграции: ничего не знают о DOM и о Tauri, поэтому
// целиком покрываются юнит-тестами. Всё, что рисует — в github-screen.ts.

import type { GhAccount, GhStatus, HostPlatform } from "./ipc";

const LINUX_DOC = "# см. https://github.com/cli/cli/blob/trunk/docs/install_linux.md";

const APT = new Set(["ubuntu", "debian", "linuxmint", "pop", "raspbian"]);
const DNF = new Set(["fedora", "rhel", "centos", "rocky", "almalinux"]);
const PACMAN = new Set(["arch", "manjaro", "endeavouros"]);
const ZYPPER = new Set(["opensuse", "opensuse-tumbleweed", "opensuse-leap", "sles"]);

/** Команда установки gh для платформы. Результат подставляется в
 *  РЕДАКТИРУЕМОЕ поле: определение пакетного менеджера — эвристика, а команда
 *  пойдёт под sudo, поэтому последнее слово остаётся за пользователем. */
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

const REQUIRED_SCOPES = ["repo"];

/** Скоупы, без которых приватные репозитории аккаунту недоступны. */
export function missingScopes(acc: GhAccount): string[] {
  return REQUIRED_SCOPES.filter((s) => !acc.scopes.includes(s));
}

export function scopeWarning(acc: GhAccount): string | null {
  const missing = missingScopes(acc);
  if (!missing.length) return null;
  return `у аккаунта нет скоупа ${missing.join(", ")} — приватные репозитории будут недоступны`;
}

export interface AccountChoice { value: string; label: string; missing: boolean; }

/** Варианты для селекта в форме воркспейса. Сохранённый логин, которого gh
 *  больше не знает, НЕ выбрасывается — иначе правка любого другого поля формы
 *  тихо снесла бы привязку. */
export function accountChoices(status: GhStatus, savedLogin?: string | null): AccountChoice[] {
  const choices: AccountChoice[] = [{ value: "", label: "— не привязан —", missing: false }];
  for (const a of status.accounts) {
    choices.push({
      value: a.login,
      label: a.active ? `${a.login} (активный в gh)` : a.login,
      missing: false,
    });
  }
  if (savedLogin && !status.accounts.some((a) => a.login === savedLogin)) {
    choices.push({ value: savedLogin, label: `${savedLogin} (не найден в gh)`, missing: true });
  }
  return choices;
}
