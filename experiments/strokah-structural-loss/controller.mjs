import { AnimationMixer, Vector3, Quaternion, Box3 } from "three";
import { MechanicalLegs, findRigNode } from "./vendor/mechanical-legs.mjs";
import { UpperBody } from "./vendor/upper-body.mjs";
import { StructuralState } from "./structural-state.mjs";
import { LimbOwnership } from "./limb-ownership.mjs";
const smooth = (x) => {
  x = Math.max(0, Math.min(1, x));
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const pos = (n) => n.getWorldPosition(new Vector3());
export class StructuralController {
  constructor(gltf, scene, config = {}) {
    this.root = gltf.scene;
    scene.add(this.root);
    const rest = MechanicalLegs.captureRest(this.root);
    const mixer = new AnimationMixer(this.root);
    mixer.clipAction(gltf.animations[0]).play();
    mixer.setTime(1 / 24);
    findRigNode(this.root, "Terrain_Walk_Test").visible = false;
    this.legs = new MechanicalLegs(this.root, rest);
    this.allLegs = [...this.legs.legs];
    this.upper = new UpperBody(this.root);
    this.state = new StructuralState(config);
    this.ownership = new LimbOwnership(this.root, scene, this.upper);
    this.saved = [];
    this.root.traverse((n) =>
      this.saved.push({
        n,
        p: n.position.clone(),
        q: n.quaternion.clone(),
        s: n.scale.clone(),
      }),
    );
    this.reset();
  }
  reset() {
    this.ownership.reset();
    for (const { n, p, q, s } of this.saved) {
      n.position.copy(p);
      n.quaternion.copy(q);
      n.scale.copy(s);
    }
    this.state.reset();
    this.legs.legs = [...this.allLegs];
    this.legs.resetMotion();
    this.upper.disabledSides = new Set();
    this.time = 0;
    this.crawlClock = 0;
    this.lossTime = null;
    this.entryFeet = null;
    this.entryHands = null;
    this.z = 0;
    this.fired = 0;
    this.recoil = 0;
    this.contacts = {};
    this.root.updateMatrixWorld(true);
    this.initialFeet = Object.fromEntries(
      this.allLegs.map((l) => [l.suffix, pos(l.ball)]),
    );
    for (const p of Object.values(this.initialFeet)) p.y = 0.035;
    this.initialHands = Object.fromEntries(
      this.upper.chains.map((c, i) => [["L", "R"][i], pos(c.nodes[3])]),
    );
    this.handRotations = Object.fromEntries(
      this.upper.chains.map((c, i) => [
        ["L", "R"][i],
        c.nodes[3].getWorldQuaternion(new Quaternion()),
      ]),
    );
    this.supportRotations = {};
    this.supportHeights = {};
    for (const side of ["L", "R"]) {
      const hand = findRigNode(this.root, `hand.${side}`),
        middle = findRigNode(this.root, `middle.01.${side}`),
        index = findRigNode(this.root, `index.01.${side}`);
      const origin = pos(hand),
        along = pos(middle).sub(origin).normalize(),
        across = pos(index).sub(pos(middle)).normalize();
      const normal = new Vector3().crossVectors(along, across).normalize();
      const q = new Quaternion().setFromUnitVectors(
        along,
        new Vector3(0, 0, 1),
      );
      const rotated = normal.applyQuaternion(q);
      rotated.z = 0;
      rotated.normalize();
      const roll = new Quaternion().setFromUnitVectors(
        rotated,
        new Vector3(0, -1, 0),
      );
      const rotation = roll.multiply(q).multiply(this.handRotations[side]);
      this.supportRotations[side] = rotation;
      const old = hand.quaternion.clone();
      hand.quaternion.copy(
        hand.parent
          .getWorldQuaternion(new Quaternion())
          .invert()
          .multiply(rotation),
      );
      this.root.updateMatrixWorld(true);
      this.supportHeights[side] =
        origin.y - new Box3().setFromObject(hand).min.y + 0.003;
      hand.quaternion.copy(old);
      this.root.updateMatrixWorld(true);
    }
    this.metrics = {};
    this.update(0);
  }
  hit(id, power = 30) {
    const result = this.state.hit(id, power);
    if (result.detached) {
      this.ownership.detach(
        id,
        new Vector3(id.endsWith("L") ? -0.55 : 0.55, 0.35, -0.2),
      );
      this.upper.disabledSides = new Set(
        ["L", "R"].filter((s) => this.state.parts[`arm.${s}`].lost),
      );
      this.legs.legs = this.allLegs.filter(
        (l) => !this.state.parts[`leg.${l.suffix}`].lost,
      );
      if (id.startsWith("leg") && this.lossTime === null) {
        this.lossTime = this.time;
        this.entryFeet = Object.fromEntries(
          this.allLegs.map((l) => [l.suffix, pos(l.ball)]),
        );
        this.entryHands = Object.fromEntries(
          this.upper.chains.map((c, i) => [["L", "R"][i], pos(c.nodes[3])]),
        );
      }
    }
    return result;
  }
  fire() {
    if (!this.state.armed) return false;
    this.fired++;
    this.recoil = 0.012;
    return true;
  }
  update(dt, { move = true, aimYaw = 0 } = {}) {
    this.time += dt;
    this.recoil *= Math.exp(-dt * 18);
    const age = this.lossTime === null ? 0 : this.time - this.lossTime;
    const blend = this.state.crawling
      ? smooth(age / this.state.config.transitionSeconds)
      : 0;
    const travelling =
      move && this.state.crawling && this.state.mobile && blend > 0.999;
    const speed = travelling ? this.state.config.crawlSpeed : 0;
    this.z += speed * dt;
    // Lower the center of mass before advancing the support contacts.
    this.legs.moveBody({ x: 0, z: this.z }, -0.4 * blend);
    this.legs.body.position.y -=
      0.012 * blend * Math.sin(Math.max(0, age - 1.2) * Math.PI * 2);
    this.root.updateMatrixWorld(true);
    if (
      travelling ||
      Object.values(this.contacts).some((c) => c.phase === "swing")
    )
      this.crawlClock += dt;
    const cycle = this.crawlClock / 1.65;
    const plan = (key, initial, end, phaseOffset, lift) => {
      let c = this.contacts[key];
      if (!c)
        c = this.contacts[key] = {
          plant: end.clone(),
          start: end.clone(),
          target: end.clone(),
          cycle: -1,
        };
      let point = initial.clone().lerp(end, blend);
      let phase = "stance",
        progress = 0;
      if (blend > 0.999) {
        const clock = cycle + phaseOffset,
          k = Math.floor(clock),
          p = clock - k;
        const swing = (travelling || c.phase === "swing") && p > 0.68;
        if (swing) {
          if (c.cycle !== k) {
            c.start.copy(c.plant);
            c.target.copy(end);
            c.target.z = this.z + end.z + 0.08;
            c.cycle = k;
          }
          progress = (p - 0.68) / 0.32;
          point.copy(c.start).lerp(c.target, smooth(progress));
          point.y += lift * Math.sin(Math.PI * progress);
          phase = "swing";
        } else {
          if (c.cycle === k - 1) c.plant.copy(c.target);
          point.copy(c.plant);
        }
      }
      c.phase = phase;
      return { point, phase, progress };
    };
    const feet = this.legs.legs.map((l) => {
      const initial = (this.entryFeet ?? this.initialFeet)[l.suffix];
      const target = this.initialFeet[l.suffix].clone();
      target.z = -0.19;
      target.y = 0.035;
      const f = plan(`foot.${l.suffix}`, initial, target, 0.5, 0.05);
      return {
        side: l.side,
        position: f.point,
        phase: f.phase,
        progress: f.progress,
        yaw: 0,
        landings: 0,
        target: { ankle: f.point, heel: { y: 0 }, toe: { y: 0 }, yaw: 0 },
      };
    });
    this.footMetrics = this.legs.solve(
      { mode: "crawl", feet, gait: { coordinated: true, dt: dt || 1 / 60 } },
      0,
      () => 0,
    );
    this.upper.aim(aimYaw, 0);
    if (this.state.armed)
      this.upper.alignBarrel(
        new Vector3(Math.sin(aimYaw), 0, Math.cos(aimYaw)),
      );
    this.upper.respond({ x: 0, z: 0.14 * blend });
    this.handPhases = {};
    const overrides = {};
    if (!this.state.armed)
      for (const s of this.state.supportHands)
        overrides[s] = {
          position: this.initialHands[s]
            .clone()
            .add(new Vector3(0, -0.4 * blend, this.z)),
          rotation: this.handRotations[s],
          weight: 1,
        };
    for (const side of this.state.supportHands) {
      if (!this.state.crawling) continue;
      const initial = (this.entryHands ?? this.initialHands)[side];
      const end = new Vector3(
        side === "L" ? 0.2 : -0.2,
        this.supportHeights[side],
        0.3,
      );
      const contact = plan(`hand.${side}`, initial, end, 0, 0.065);
      this.handPhases[side] = contact.phase;
      overrides[side] = {
        position: contact.point,
        rotation: this.supportRotations[side],
        weight: blend,
      };
    }
    if (this.state.armed) {
      this.upper.articulate(
        {
          torsoPitch: 0.55 * blend,
          gripOverrides: overrides,
          weapon: { recoil: this.recoil },
        },
        0,
      );
    } else {
      // Dropped weapon is no longer a transform owner or a target for either arm.
      const waist = this.upper.waist;
      waist.rotateX(0.55 * blend);
      this.root.updateMatrixWorld(true);
      this.upper.solveGrips({ gripOverrides: overrides });
    }
    this.ownership.update(dt);
    this.root.updateMatrixWorld(true);
    this.metrics = {
      blend,
      z: this.z,
      armed: this.state.armed,
      mobile: this.state.mobile,
      mode: this.state.crawling
        ? this.state.mobile
          ? "hand-assisted crawl"
          : "braced / insufficient support"
        : "standing",
      debris: this.ownership.debris.length,
      gripErrors: this.upper.armErrors,
      feet: this.footMetrics.map((f) => ({
        side: f.side,
        error: f.error,
        clearance: f.clearance,
      })),
      hands: Object.fromEntries(
        this.state.supportHands.map((s) => {
          const n = this.upper.chains[s === "L" ? 0 : 1].nodes[3];
          const box = new Box3().setFromObject(n);
          return [
            s,
            {
              phase: this.handPhases[s] ?? "free",
              position: pos(n).toArray(),
              clearance: box.min.y,
            },
          ];
        }),
      ),
    };
    return this.metrics;
  }
}
