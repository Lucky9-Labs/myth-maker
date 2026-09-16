export const LIMBS = ["arm.L", "arm.R", "leg.L", "leg.R"];
export const DEFAULTS = Object.freeze({
  armor: 60,
  minimumImpact: 25,
  structuralCapacity: 90,
  minimumHits: 3,
  transitionSeconds: 1.2,
  crawlSpeed: 0.075,
});
// Input is a resolved bone impact, never a stagger signal. Armor breaches do not
// spill damage into structure on the same hit, matching MechPartDamageState.
export class StructuralState {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    for (const [k, v] of Object.entries(this.config))
      if (!Number.isFinite(v) || v < 0) throw Error(`Invalid ${k}`);
    if (
      this.config.transitionSeconds === 0 ||
      this.config.minimumHits < 1 ||
      this.config.structuralCapacity === 0
    )
      throw Error("Invalid structural configuration");
    this.reset();
  }
  reset() {
    this.parts = Object.fromEntries(
      LIMBS.map((id) => [
        id,
        { armor: this.config.armor, stress: 0, hits: 0, lost: false },
      ]),
    );
    this.events = [];
  }
  hit(id, power) {
    const p = this.parts[id];
    if (!p) throw Error(`Unknown limb ${id}`);
    if (!Number.isFinite(power) || power <= 0 || p.lost)
      return { detached: false, reason: "ignored" };
    if (p.armor > 0) {
      p.armor = Math.max(0, p.armor - power);
      return { detached: false, reason: p.armor === 0 ? "exposed" : "armored" };
    }
    if (power < this.config.minimumImpact)
      return { detached: false, reason: "below structural threshold" };
    p.stress += power;
    p.hits++;
    if (
      p.stress >= this.config.structuralCapacity &&
      p.hits >= this.config.minimumHits
    ) {
      p.lost = true;
      const event = { id, index: this.events.length, power };
      this.events.push(event);
      return { detached: true, event };
    }
    return { detached: false, reason: "structural damage" };
  }
  get crawling() {
    return this.parts["leg.L"].lost || this.parts["leg.R"].lost;
  }
  get armed() {
    return !this.parts["arm.R"].lost;
  }
  get supportHands() {
    return ["L", "R"].filter(
      (s) => !this.parts[`arm.${s}`].lost && (s !== "R" || !this.armed),
    );
  }
  get mobile() {
    return (
      !this.crawling ||
      (this.supportHands.length > 0 &&
        (!this.parts["leg.L"].lost || !this.parts["leg.R"].lost))
    );
  }
}
