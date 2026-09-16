import { Group, Vector3, Box3 } from "three";
import { findRigNode } from "./vendor/mechanical-legs.mjs";
// Detach the original hierarchy, not a clone: mesh descendants, shoulder shells,
// fingers, hit proxies and explicit equipment all share one debris transform.
export class LimbOwnership {
  constructor(root, scene, upper) {
    this.root = root;
    this.scene = scene;
    this.upper = upper;
    this.records = new Map();
    this.debris = [];
    for (const kind of ["arm", "leg"])
      for (const side of ["L", "R"]) {
        const node = findRigNode(
          root,
          `${kind === "arm" ? "upper_arm" : "thigh"}.${side}`,
        );
        const owned = [node];
        if (kind === "arm" && side === "R") owned.push(upper.gripRig.control);
        this.records.set(
          `${kind}.${side}`,
          owned.map((n) => ({
            node: n,
            parent: n.parent,
            position: n.position.clone(),
            quaternion: n.quaternion.clone(),
            scale: n.scale.clone(),
          })),
        );
      }
  }
  detach(id, impulse = new Vector3(0.35, 0.35, -0.3)) {
    if (this.debris.some((d) => d.id === id)) return false;
    const records = this.records.get(id);
    if (!records) throw Error(`Unknown limb ${id}`);
    this.root.updateMatrixWorld(true);
    const group = new Group();
    group.name = `DEBRIS_${id}`;
    group.position.copy(records[0].node.getWorldPosition(new Vector3()));
    this.scene.add(group);
    group.updateMatrixWorld(true);
    for (const r of records) group.attach(r.node);
    const colliders = [];
    group.traverse((n) => {
      if (n.isMesh) {
        n.userData.collisionOwner = group.name;
        colliders.push(n.uuid);
      }
    });
    this.debris.push({
      id,
      group,
      velocity: impulse.clone(),
      angular: new Vector3(0.6, 0, id.endsWith("L") ? -0.8 : 0.8),
      colliders,
      settled: false,
    });
    return true;
  }
  // Triangle meshes are the preview hit colliders. Detached geometry is queried
  // separately and can never receive an actor structural hit again.
  raycast(raycaster) {
    const active = [];
    for (const [id, records] of this.records) {
      if (this.debris.some((d) => d.id === id)) continue;
      for (const r of records) {
        r.node.updateWorldMatrix(true, true);
        for (const hit of raycaster.intersectObject(r.node, true))
          active.push({ ...hit, limb: id });
      }
    }
    return active.sort((a, b) => a.distance - b.distance);
  }
  update(dt) {
    for (const d of this.debris) {
      if (d.settled) continue;
      d.velocity.y -= 2.3 * dt;
      d.group.position.addScaledVector(d.velocity, dt);
      d.group.rotateX(d.angular.x * dt);
      d.group.rotateZ(d.angular.z * dt);
      d.group.updateMatrixWorld(true);
      const box = new Box3().setFromObject(d.group);
      if (box.min.y < 0.002) {
        d.group.position.y += 0.002 - box.min.y;
        d.velocity.set(0, 0, 0);
        d.settled = true;
      }
    }
  }
  reset() {
    for (const records of this.records.values())
      for (const r of records) {
        r.parent.add(r.node);
        r.node.position.copy(r.position);
        r.node.quaternion.copy(r.quaternion);
        r.node.scale.copy(r.scale);
        r.node.traverse((n) => {
          delete n.userData.collisionOwner;
        });
      }
    for (const d of this.debris) this.scene.remove(d.group);
    this.debris = [];
    this.root.updateMatrixWorld(true);
  }
}
