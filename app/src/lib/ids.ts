/** Snowflakes are strings; compare numerically without BigInt allocation. */
export function cmpId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

const EPOCH = 1_767_225_600_000;

export function idTime(id: string): number {
  return Number(BigInt(id) >> 22n) + EPOCH;
}
