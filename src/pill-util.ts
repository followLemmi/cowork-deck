/** Pure label formatting for the "N waiting" status pill. No DOM/Tauri
 *  dependency — unit-tested directly without a jsdom environment. */
export function pillLabel(n: number): string {
  const verb = n % 10 === 1 && n % 100 !== 11 ? "ждёт" : "ждут";
  return `${n} ${verb} ввода`;
}
