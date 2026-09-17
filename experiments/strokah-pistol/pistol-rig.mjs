import { Object3D, Vector3, Quaternion, Matrix4 } from "three";
import { SingleHandCarry, singleHandCarry } from "./single-hand-carry.mjs";
import { findRigNode as node } from "../strokah-structural-loss/vendor/mechanical-legs.mjs";
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const pos = (n) => n.getWorldPosition(V()),
  rot = (n) => n.getWorldQuaternion(new Quaternion());
const mirrorQ = (q) => new Quaternion(q.x, -q.y, -q.z, q.w);
const smooth = (x) => {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
};
export const RELOAD_SECONDS = 2.4;
// Right-handed, rigid weapon-local metres; left ownership reflects anchors and
// rotations, never model scales. The weapon owns all common motion.
export class PistolRig {
  constructor(root, upper, weapon, bindPose = [], contract = {}) {
    this.carry = new SingleHandCarry();
    this.root = root;
    this.upper = upper;
    this.weapon = weapon;
    this.side = "R";
    root.updateMatrixWorld(true);
    this.rightRotation =
      contract.rightRotation?.clone() ?? rot(node(root, "hand.R"));
    this.neutralWrist =
      bindPose.find((x) => x.n.name === node(root, "hand.R").name)?.q.clone() ??
      new Quaternion(
        0.03420230746269226,
        -0.018773404881358147,
        -0.0005773977609351277,
        0.9992384314537048,
      );
    this.fingers = [];
    for (const finger of ["index", "middle", "ring", "thumb"])
      for (let j = 1; j <= 3; j++) {
        const r = node(root, `${finger}.0${j}.R`),
          l = node(root, `${finger}.0${j}.L`);
        this.fingers.push({
          r,
          l,
          q: r.quaternion.clone(),
          left: l.quaternion.clone(),
          rest:
            bindPose.find((x) => x.n.name === r.name)?.q.clone() ??
            r.quaternion.clone(),
        });
      }
    this.anchors = {};
    for (const side of ["L", "R"]) {
      const a = new Object3D();
      a.name = `GRIP_pistol_${side}`;
      a.position.set(side === "R" ? -0.068 : 0.068, 0.008, -0.155);
      a.quaternion.copy(
        side === "R" ? this.rightRotation : mirrorQ(this.rightRotation),
      );
      weapon.add(a);
      this.anchors[side] = a;
    }
    this.trigger = new Object3D();
    this.trigger.name = "TRIGGER";
    this.trigger.position.set(0, 0, -0.018);
    weapon.add(this.trigger);
    this.magwell = new Object3D();
    this.magwell.name = "MAGWELL";
    this.magwell.position.set(0, -0.034, 0.044);
    weapon.add(this.magwell);
    this.muzzle = new Object3D();
    this.muzzle.name = "MUZZLE";
    this.muzzle.position.set(0, 0.067, 0.2);
    weapon.add(this.muzzle);
    this.rifle = upper.gripRig;
    // Shape the trigger index separately from the load-bearing fingers.
    const fingerDirections = {
      index: [
        V(0.013, 0, 0.028),
        V(0.033, -0.006, 0.016),
        V(0.018, -0.005, -0.012),
      ],
      middle: [V(0.005, 0, 0.035), V(0.023, 0, 0.031), V(0.025, 0, 0.008)],
      ring: [V(0, 0, 0.033), V(0.028, 0, 0.022), V(0.025, 0, 0.003)],
      thumb: [V(0.028, 0.01, 0.028), V(0.03, 0.003, 0.012), V(0.025, 0, 0)],
    };
    for (const [finger, directions] of Object.entries(fingerDirections)) {
      let parent = this.rightRotation.clone();
      for (let j = 1; j <= 3; j++) {
        const f = this.fingers.find(
          (f) => f.r === node(root, `${finger}.0${j}.R`),
        );
        const world = parent.clone().multiply(f.q);
        world.premultiply(
          new Quaternion().setFromUnitVectors(
            V(0, 1, 0).applyQuaternion(world),
            directions[j - 1].normalize(),
          ),
        );
        f.q.copy(parent.clone().invert().multiply(world));
        parent = world;
      }
    }
    this.magazine = weapon.children.find((n) => n.name === "tripo_part_3");
  }
  update(time, state = "ready", side = "R", options = {}) {
    if (!["L", "R"].includes(side))
      throw Error("Pistol ownership must be L or R");
    const disabled =
      options.disabledSides ?? this.upper.disabledSides ?? new Set();
    const supportSide = side === "R" ? "L" : "R";
    // Author and solve the right side once. The intact left variant is the exact
    // reflected result, including the support arm and fingers, not another IK branch.
    if (
      side === "L" &&
      !options.canonical &&
      !disabled.size &&
      !options.weaponBracing &&
      !options.supportOverride
    ) {
      this.root.updateMatrixWorld(true);
      const frame = this.upper.waist.matrixWorld.clone(),
        reflection = new Matrix4().makeScale(-1, 1, 1);
      const worldReflection = frame
        .clone()
        .multiply(reflection)
        .multiply(frame.clone().invert());
      const m = this.update(time, state, "R", {
        ...options,
        canonical: true,
        carryPhaseSign: -1,
      });
      const chains = this.upper.chains;
      const rotations = chains.map((c) =>
        c.nodes.map((n) => n.quaternion.clone()),
      );
      for (let j = 0; j < 4; j++) {
        chains[0].nodes[j].quaternion.copy(mirrorQ(rotations[1][j]));
        chains[1].nodes[j].quaternion.copy(mirrorQ(rotations[0][j]));
      }
      for (const f of this.fingers) {
        const rq = f.r.quaternion.clone();
        f.r.quaternion.copy(mirrorQ(f.l.quaternion));
        f.l.quaternion.copy(mirrorQ(rq));
      }
      this.weapon.updateWorldMatrix(true, false);
      const reflected = worldReflection
        .multiply(this.weapon.matrixWorld)
        .multiply(reflection);
      if (this.weapon.parent)
        reflected.premultiply(this.weapon.parent.matrixWorld.clone().invert());
      reflected.decompose(
        this.weapon.position,
        this.weapon.quaternion,
        this.weapon.scale,
      );
      this.root.updateMatrixWorld(true);
      this.weapon.updateMatrixWorld(true);
      this.side = "L";
      return (this.metrics = {
        ...m,
        side: "L",
        gripError: pos(chains[0].nodes[3]).distanceTo(pos(this.anchors.L)),
      });
    }
    this.side = side;
    if (disabled.has(side) || options.weaponBracing) {
      const hand = this.upper.chains[side === "L" ? 0 : 1].nodes[3],
        anchor = this.anchors[side];
      hand.updateWorldMatrix(true, false);
      anchor.updateMatrix();
      const world = hand.matrixWorld
        .clone()
        .multiply(anchor.matrix.clone().invert());
      if (this.weapon.parent)
        world.premultiply(this.weapon.parent.matrixWorld.clone().invert());
      world.decompose(
        this.weapon.position,
        this.weapon.quaternion,
        this.weapon.scale,
      );
      this.weapon.updateMatrixWorld(true);
      return (this.metrics = {
        side,
        state,
        armed: !disabled.has(side),
        canFire: false,
        weaponBracing: !!options.weaponBracing,
        gripError: pos(hand).distanceTo(pos(anchor)),
        supportOverrideWeight: 0,
        magazineExtraction: 0,
      });
    }
    const sign = side === "R" ? -1 : 1,
      aim = options.aimWeight ?? (["aim", "fire"].includes(state) ? 1 : 0),
      reload = state === "reload" && !disabled.has(supportSide);
    for (const f of this.fingers) {
      if (!disabled.has("R")) f.r.quaternion.copy(f.q);
      if (!disabled.has("L")) f.l.quaternion.copy(mirrorQ(f.q));
    }
    // Mirror the accepted mechanical elbow starting branch before each solve.
    const r = this.upper.chains[1],
      l = this.upper.chains[0];
    for (let j = 1; j < 4; j++) {
      if (!disabled.has("R")) r.nodes[j].quaternion.copy(r.base[j]);
      if (!disabled.has("L")) l.nodes[j].quaternion.copy(mirrorQ(r.base[j]));
    }
    const phase = time % RELOAD_SECONDS,
      u = phase / RELOAD_SECONDS;
    const reach = reload
      ? smooth(u / 0.16) * (1 - smooth((u - 0.82) / 0.18))
      : 0;
    const extraction = reload
      ? u < 0.42
        ? smooth((u - 0.25) / 0.17)
        : 1 - smooth((u - 0.58) / 0.18)
      : 0;
    const recoil =
      state === "fire"
        ? Math.exp(-((time % 0.72) / 0.095)) *
          Math.sin((Math.min(1, (time % 0.72) / 0.035) * Math.PI) / 2)
        : 0;
    const bob =
      state === "walk"
        ? Math.sin(time * 8) * 0.012
        : state === "sprint"
          ? Math.sin(time * 12) * 0.018
          : Math.sin(time * 2) * 0.002;
    this.weapon.position.set(0, 0, 0);
    this.weapon.quaternion.setFromAxisAngle(
      V(1, 0, 0),
      (options.pitch ??
        (state === "sprint" ? 0.75 : 0.28 + (-0.025 - 0.28) * aim)) + bob,
    );
    if (reload) {
      this.weapon.quaternion.premultiply(
        new Quaternion().setFromAxisAngle(V(1, 0, 0), -0.75 * reach),
      );
      this.weapon.quaternion.multiply(
        new Quaternion().setFromAxisAngle(V(0, 0, 1), sign * 0.25 * reach),
      );
      this.weapon.quaternion.premultiply(
        new Quaternion().setFromAxisAngle(V(0, 1, 0), -sign * 0.25 * reach),
      );
    }
    this.weapon.quaternion.multiply(
      new Quaternion().setFromAxisAngle(V(1, 0, 0), -recoil * 0.12),
    );
    this.weapon.updateMatrixWorld(true);
    let carry = null,
      carryPair = null;
    if (state === "walk" || state === "sprint") {
      const separation =
        (pos(node(this.root, "ball.L")).z - pos(node(this.root, "ball.R")).z) *
        (options.carryPhaseSign ?? 1);
      carryPair = this.carry.sample(
        time,
        state === "sprint",
        separation,
        options.carryPhaseSign ?? 1,
      );
      carry = carryPair[side];
      const c = this.upper.chains[side === "R" ? 1 : 0];
      c.nodes.forEach((n, i) => n.quaternion.copy(carry.rotations[i]));
      this.root.updateMatrixWorld(true);
      this.weapon.quaternion.copy(
        rot(c.nodes[3]).multiply(
          this.anchors[side].quaternion.clone().invert(),
        ),
      );
      this.weapon.updateMatrixWorld(true);
    }
    // Project the common weapon frame onto the reachable wrist-aligned pose.
    // The chosen elbow angle is a bounded local-X hinge delta; all segment
    // lengths and shoulder origins remain the exported values.
    const activeChain = this.upper.chains[side === "R" ? 1 : 0];
    const [mount, arm, elbow, hand] = activeChain.nodes;
    const localElbow = carry
      ? carry.rotations[2].clone()
      : side === "R"
        ? r.base[2].clone()
        : mirrorQ(r.base[2]);
    if (!carry)
      localElbow.multiply(
        new Quaternion().setFromAxisAngle(
          V(1, 0, 0),
          (options.elbow ??
            0.65 * aim +
              (state === "sprint" ? -0.15 : reload ? -0.35 * reach : 0) *
                (1 - aim)) -
            recoil * 0.13,
        ),
      );
    const neutral =
      side === "R" ? this.neutralWrist.clone() : mirrorQ(this.neutralWrist);
    // Single-hand idle rests beside the hip; blend back into the shared
    // action pose as aiming or magazine service takes ownership.
    const sideRest =
      !carry && !options.supportOverride ? (1 - aim) * (1 - reach) : 0;
    if (sideRest > 0) {
      const rest = singleHandCarry(0, false, 0, side).rotations;
      const restHand = rot(mount)
        .multiply(rest[1])
        .multiply(rest[2])
        .multiply(neutral);
      const restWeapon = restHand.multiply(
        this.anchors[side].quaternion.clone().invert(),
      );
      this.weapon.quaternion.slerp(restWeapon, sideRest);
      localElbow.slerp(rest[2], sideRest);
      this.weapon.updateMatrixWorld(true);
    }
    const desiredHand = rot(this.anchors[side]);
    const desiredForearm = desiredHand
      .clone()
      .multiply(neutral.clone().invert());
    // Shared pistol wrist articulation opens the elbow while
    // retaining parallel weapon axes; never splay the barrels for clearance.
    if (aim > 0 && !carry && !options.supportOverride) {
      desiredForearm.premultiply(
        new Quaternion().setFromAxisAngle(
          V(0, 1, 0),
          -0.15 * aim * (side === "R" ? 1 : -1),
        ),
      );
      desiredForearm.premultiply(
        new Quaternion().setFromAxisAngle(
          V(0, 0, 1),
          -0.8 * aim * (side === "R" ? 1 : -1),
        ),
      );
      neutral.copy(desiredForearm.clone().invert().multiply(desiredHand));
    }
    const desiredArm = desiredForearm
      .clone()
      .multiply(localElbow.clone().invert());
    const wrist = pos(arm)
      .add(elbow.position.clone().applyQuaternion(desiredArm))
      .add(hand.position.clone().applyQuaternion(desiredForearm));
    this.weapon.position
      .copy(wrist)
      .sub(
        this.anchors[side].position
          .clone()
          .applyQuaternion(this.weapon.quaternion),
      );
    this.weapon.updateMatrixWorld(true);
    const targets = ["L", "R"].map((s) => ({
      position: pos(this.anchors[s]),
      rotation: rot(this.anchors[s]),
    }));
    const support = side === "R" ? 0 : 1,
      active = 1 - support;
    for (const f of this.fingers) {
      if (disabled.has(supportSide)) continue;
      const n = side === "R" ? f.l : f.r;
      const rest = side === "R" ? mirrorQ(f.rest) : f.rest;
      const grasp = side === "R" ? mirrorQ(f.q) : f.q;
      n.quaternion.copy(rest).slerp(grasp, reach);
      if (options.supportFingerPose?.[n.name])
        n.quaternion.copy(options.supportFingerPose[n.name]);
    }

    const free = pos(this.upper.chains[support].nodes[1]).add(
      V(
        -sign * 0.1,
        -0.32,
        0.06 + (state === "walk" ? Math.sin(time * 8) * 0.055 : 0),
      ),
    );
    const service = this.weapon.localToWorld(
      V(-sign * 0.06, 0.005 - extraction * 0.11, -0.047),
    );
    if (this.magazine) this.magazine.position.y = -extraction * 0.11;
    targets[support].position.copy(free).lerp(service, reach);
    targets[support].rotation.copy(rot(this.anchors[side === "R" ? "L" : "R"]));
    targets[support].rotation.premultiply(
      new Quaternion().setFromAxisAngle(V(1, 0, 0), 0.8 * (1 - reach)),
    );
    if (carry) {
      const separation =
        (pos(node(this.root, "ball.L")).z - pos(node(this.root, "ball.R")).z) *
        (options.carryPhaseSign ?? 1);
      const other = carryPair[supportSide],
        c = this.upper.chains[support];
      c.nodes.forEach((n, i) => n.quaternion.copy(other.rotations[i]));
      this.root.updateMatrixWorld(true);
      targets[support] = {
        position: pos(c.nodes[3]),
        rotation: rot(c.nodes[3]),
      };
    }
    if (options.supportOverride) {
      targets[support].position.lerp(
        options.supportOverride.position,
        options.supportOverride.weight ?? 1,
      );
      if (options.supportOverride.rotation)
        targets[support].rotation.copy(options.supportOverride.rotation);
    }
    this.upper.gripRig = { targets: () => targets };
    const previousDisabled = this.upper.disabledSides;
    this.upper.disabledSides = disabled;
    try {
      this.upper.solveGrips();
    } finally {
      this.upper.gripRig = this.rifle;
      this.upper.disabledSides = previousDisabled;
    }
    arm.quaternion.copy(rot(arm.parent).invert().multiply(desiredArm));
    elbow.quaternion.copy(localElbow);
    hand.quaternion.copy(neutral);
    this.root.updateMatrixWorld(true);
    this.upper.armErrors[side === "R" ? 1 : 0] = pos(hand).distanceTo(
      pos(this.anchors[side]),
    );
    this.metrics = {
      side,
      state,
      armed: true,
      canFire: !reload,
      weaponBracing: false,
      reloadPhase: u,
      supportOverrideWeight: reach,
      magazineExtraction: extraction,
      gripError: pos(hand).distanceTo(pos(this.anchors[side])),
      supportError: disabled.has(supportSide)
        ? 0
        : pos(this.upper.chains[support].nodes[3]).distanceTo(
            targets[support].position,
          ),
      recoil,
    };
    return this.metrics;
  }
}
