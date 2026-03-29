export function linearMap(x: number, a: number, b: number, c: number, d: number): number {
  return ((x - a) * (d - c)) / (b - a) + c;
}
