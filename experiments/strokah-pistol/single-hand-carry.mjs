import { Quaternion, Vector3 } from "three";
// Port of the existing StrokahMeleeMotion.Tick single-handed/katar carry.
// Source: mech game/Assets/Scripts/Presentation/StrokahMeleeMotion.cs, 2026-09-17.
// Quaternion values are the authored Three/GLB values before Unity's X reflection.
export const RIGHT_CARRY_REST = [
  [0.026460752, 0.026460791, 0.706611514, 0.706611514],
  [-0.580314338, 0.803885043, 0.056495037, 0.117526487],
  [-0.160889253, -0.045671474, 0.104150228, 0.980398655],
  [0.034202307, -0.018773405, -0.000577398, 0.999238431],
].map((q) => new Quaternion(...q));
const X = (a) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), a);
export function singleHandCarry(time, sprint, footSeparation, side = "R") {
  // A deterministic sample of the existing exponential move/sprint envelopes.
  const moving = 1 - Math.exp(-Math.max(0, time) / 0.12),
    fast = sprint ? 1 - Math.exp(-Math.max(0, time) / 0.2) : 0;
  const swing =
    Math.max(-1, Math.min(1, footSeparation / 0.38)) *
    (sprint ? 0.48 : 0.3) *
    moving;
  const lead = (side === "R" ? 1 : -1) * swing * 1.15;
  // The live host supplies the current foot separation; sampling uses the same
  // carry target, while the host remains responsible for frame-to-frame springing.
  const elbow = 0.12 + (0.65 + 0.48 * fast) * moving - 0.38 * lead;
  const q = RIGHT_CARRY_REST.map((q) => q.clone());
  q[1].multiply(X(0.04 + (-0.04 - 0.12 * fast) * moving + lead));
  q[2].multiply(X(-elbow));
  if (side === "L") for (const r of q) r.set(r.x, -r.y, -r.z, r.w);
  return {
    rotations: q,
    swing,
    lead,
    elbow,
    locomotion: moving,
    sprintWeight: fast,
  };
}
// Same inertia and bounded quaternion spring as StrokahMeleeDynamics.Spring.
function spring(current, target, velocity, h) {
  const error = target.clone().multiply(current.clone().invert()).normalize();
  if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
  const axis = new Vector3(error.x, error.y, error.z),
    length = axis.length();
  const displacement =
    length > 1e-9
      ? axis.multiplyScalar((2 * Math.atan2(length, error.w)) / length)
      : axis;
  const acceleration = displacement
    .multiplyScalar(196)
    .addScaledVector(velocity, -28)
    .clampLength(0, 70);
  velocity.addScaledVector(acceleration, h).clampLength(0, 7);
  const speed = velocity.length();
  if (speed > 1e-9)
    current
      .premultiply(
        new Quaternion().setFromAxisAngle(
          velocity.clone().divideScalar(speed),
          speed * h,
        ),
      )
      .normalize();
}
export class SingleHandCarry {
  reset(key) {
    this.key = key;
    this.time = 0;
    this.locomotion = 0;
    this.sprintWeight = 0;
    this.lag = [0, 0];
    this.current = ["L", "R"].map((s) =>
      RIGHT_CARRY_REST.map((q) =>
        s === "R" ? q.clone() : new Quaternion(q.x, -q.y, -q.z, q.w),
      ),
    );
    this.velocity = this.current.map((a) => a.map(() => new Vector3()));
  }
  sample(time, sprint, footSeparation, phaseSign = 1) {
    const key = `${sprint}/${phaseSign}`;
    if (this.key !== key || time < this.time) this.reset(key);
    const dt = Math.max(0, time - this.time),
      steps = Math.max(1, Math.ceil(dt * 60)),
      h = dt / steps;
    for (let step = 0; step < steps; step++) {
      this.locomotion += (1 - this.locomotion) * (1 - Math.exp(-h / 0.12));
      this.sprintWeight +=
        ((sprint ? 1 : 0) - this.sprintWeight) * (1 - Math.exp(-h / 0.2));
      const swing =
        Math.max(-1, Math.min(1, footSeparation / 0.38)) *
        (sprint ? 0.48 : 0.3) *
        this.locomotion;
      for (const [i, side] of ["L", "R"].entries()) {
        const sign = side === "R" ? 1 : -1,
          lead = sign * swing * 1.15;
        this.lag[i] +=
          (lead - this.lag[i]) * (1 - Math.exp(-h / (i === 0 ? 0.065 : 0.08)));
        const elbow =
          0.12 +
          (0.65 + 0.48 * this.sprintWeight) * this.locomotion -
          0.38 * this.lag[i];
        const q = RIGHT_CARRY_REST.map((q) =>
          side === "R" ? q.clone() : new Quaternion(q.x, -q.y, -q.z, q.w),
        );
        q[1].multiply(
          X(0.04 + (-0.04 - 0.12 * this.sprintWeight) * this.locomotion + lead),
        );
        q[2].multiply(X(-elbow));
        q[3].multiply(X(0.12 * (this.lag[i] - lead)));
        for (let j = 0; j < 4; j++)
          spring(this.current[i][j], q[j], this.velocity[i][j], h);
      }
    }
    this.time = time;
    return {
      L: { rotations: this.current[0].map((q) => q.clone()) },
      R: { rotations: this.current[1].map((q) => q.clone()) },
    };
  }
}
