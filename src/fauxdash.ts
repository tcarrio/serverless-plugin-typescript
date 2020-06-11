export function last<T = any>(arr: Array<T>): T {
  return [...arr].pop();
}

export const values = Object.values;

export function uniq<T = any>(arr: Array<T>): Array<T> {
  return [...new Set(arr)];
}
