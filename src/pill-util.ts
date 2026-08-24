/** Pure label formatting for the "N waiting" status pill. No DOM/Tauri
 *  dependency — unit-tested directly without a jsdom environment. */
export function pillLabel(n: number): string {
  return `${n} waiting for input`;
}
