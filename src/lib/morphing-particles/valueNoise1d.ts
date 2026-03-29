/** 1D value noise with smooth interpolation — from the original bundle (`JA` / `Rb`). */
export class ValueNoise1D {
  MAX_VERTICES = 256;
  MAX_VERTICES_MASK = 255;
  amplitude = 1;
  scale = 1;
  private readonly r: number[] = [];

  constructor() {
    for (let i = 0; i < this.MAX_VERTICES; ++i) this.r.push(Math.random());
  }

  private lerp(e: number, t: number, i: number): number {
    return e * (1 - i) + t * i;
  }

  getVal(e: number): number {
    const t = e * this.scale;
    const i = Math.floor(t);
    const r = t - i;
    const o = r * r * (3 - 2 * r);
    const s = i & this.MAX_VERTICES_MASK;
    const a = (s + 1) & this.MAX_VERTICES_MASK;
    const l = this.lerp(this.r[s], this.r[a], o);
    return l * this.amplitude;
  }
}
