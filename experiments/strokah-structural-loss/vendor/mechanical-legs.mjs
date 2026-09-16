import { Vector3, Quaternion, Matrix4 } from 'three';
const up = new Vector3(0, 1, 0);
const worldPosition = o => o.getWorldPosition(new Vector3());
const worldRotation = o => o.getWorldQuaternion(new Quaternion());
function basis(direction, normal) {
  const x = normal.clone().normalize();
  const y = direction.clone().addScaledVector(x, -direction.dot(x)).normalize();
  const z = new Vector3().crossVectors(x, y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}
function hingePlane(forward, hipToFoot, axialOffset) {
  const across = hipToFoot.clone().addScaledVector(forward, -hipToFoot.dot(forward));
  let normal = new Vector3().crossVectors(forward, across).normalize();
  if (normal.lengthSq() < .5) normal.set(forward.z, 0, -forward.x);
  if (normal.dot(new Vector3(forward.z, 0, -forward.x)) < 0) normal.negate();
  const sin = Math.max(-.99, Math.min(.99, axialOffset / Math.max(.001, across.length())));
  return normal.multiplyScalar(Math.sqrt(1 - sin * sin)).addScaledVector(across.normalize(), sin).normalize();
}

function setWorldRotation(node, rotation) {
  node.quaternion.copy(worldRotation(node.parent).invert().multiply(rotation));
  node.updateWorldMatrix(false, true);
}

export function meshClearance(node, groundHeight, stride = 1) {
  let clearance = Infinity;
  const point = new Vector3();
  node.traverse(mesh => {
    if (!mesh.isMesh) return;
    const vertices = mesh.geometry.attributes.position;
    for (let i = 0; i < vertices.count; i += stride) {
      point.fromBufferAttribute(vertices, i).applyMatrix4(mesh.matrixWorld);
      clearance = Math.min(clearance, point.y - groundHeight(point.x, point.z));
    }
  });
  return clearance;
}

export function articulateContact(node, axis, groundHeight, planted, preferNeutral = false) {
  const initial = worldRotation(node);
  const initialClearance = meshClearance(node, groundHeight);
  // Keep an already supported sole at its intended pitch. Searching again
  // merely to shave off a millimeter can rock a flat toe onto its rear edge.
  if (initialClearance >= .001 && (!planted || initialClearance <= .005)) return;
  let best = { angle: 0, cost: Infinity };
  // Larger level-ground corrections belong to the existing foot-height solve.
  const limit = preferNeutral ? 3 : 14;
  for (let i = -limit; i <= limit; i++) {
    const angle = i * .05;
    setWorldRotation(node, new Quaternion().setFromAxisAngle(axis, angle).multiply(initial));
    const clearance = meshClearance(node, groundHeight);
    // On level ground prefer the smallest toe correction over edge contact.
    // Sloped contacts and heel articulation retain their contact-seeking cost.
    const cost = clearance < .001 ? 1000 + (.001 - clearance) * 50 : clearance - .002 + (preferNeutral ? Math.abs(angle) : 0);
    if (cost + Math.abs(angle) * .0001 < best.cost) best = { angle, cost: cost + Math.abs(angle) * .0001 };
  }
  const coarseAngle = best.angle;
  best = { angle: coarseAngle, cost: Infinity };
  for (const offset of [-.05, -.025, 0, .025, .05]) {
    const angle = Math.max(preferNeutral ? -.15 : -.75, Math.min(preferNeutral ? .15 : .75, coarseAngle + offset));
    setWorldRotation(node, new Quaternion().setFromAxisAngle(axis, angle).multiply(initial));
    const clearance = meshClearance(node, groundHeight);
    // On level ground prefer the smallest toe correction over edge contact.
    // Sloped contacts and heel articulation retain their contact-seeking cost.
    const cost = clearance < .001 ? 1000 + (.001 - clearance) * 50 : clearance - .002 + (preferNeutral ? Math.abs(angle) : 0);
    if (cost < best.cost) best = { angle, cost };
  }
  setWorldRotation(node, new Quaternion().setFromAxisAngle(axis, best.angle).multiply(initial));
}

export function findRigNode(root, name) {
  let found;
  root.traverse(n => { if (n.name === name || n.userData.name === name || n.name === name.replaceAll('.', '')) found = n; });
  if (!found) throw new Error(`Missing rig node ${name}`);
  return found;
}

export class MechanicalLegs {
  static captureRest(root) {
    root.updateMatrixWorld(true);
    return Object.fromEntries(['L', 'R'].map(side => {
      const normal = new Vector3(1, 0, 0).applyQuaternion(worldRotation(findRigNode(root, `shin.${side}`)));
      if (normal.x < 0) normal.negate();
      const frame = basis(new Vector3(0, 0, 1), normal).invert();
      return [side, ['ball', 'heel', 'toe'].map(name => frame.clone().multiply(worldRotation(findRigNode(root, `${name}.${side}`))))];
    }));
  }

  constructor(root, restFeet) {
    if (!restFeet) throw new Error('Capture neutral foot references before sampling animation');
    this.root = root;
    this.body = findRigNode(root, 'CTRL_locomotion');
    this.bodyOrigin = this.body.position.clone();
    // The original control started at .08 m with .12 m of reach compensation.
    // A taller authored offset must retain that same lower reach boundary.
    this.maxPelvisDrop = .12 + Math.max(0, this.bodyOrigin.y - .08);
    this.bodyRotation = this.body.quaternion.clone();
    root.updateMatrixWorld(true);
    this.legs = ['L', 'R'].map(suffix => {
      const nodes = ['thigh', 'shin', 'lower_shin', 'ball', 'heel', 'toe']
        .map(name => findRigNode(root, `${name}.${suffix}`));
      const [thigh, shin, lower, ball, heel, toe] = nodes;
      const p = [thigh, shin, lower, ball].map(worldPosition);
      const direction = p.slice(1).map((v, i) => v.clone().sub(p[i]));
      let normal = new Vector3(1, 0, 0).applyQuaternion(worldRotation(shin));
      if (normal.x < 0) normal.negate();
      const references = [thigh, shin, lower].map((node, i) => ({
        node, offset: basis(direction[i], normal).invert().multiply(worldRotation(node))
      }));
      const footRefs = [ball, heel, toe].map((node, i) => ({ node,
        offset: restFeet[suffix][i].clone() }));
      return { suffix, side: p[3].x < 0 ? 'L' : 'R', thigh, shin, lower, ball, heel, toe,
        axialOffset: direction.reduce((sum, v) => sum + v.dot(normal), 0),
        lengths: direction.map(v => v.clone().addScaledVector(normal, -v.dot(normal)).length()), references, footRefs };
    });
  }

  resetMotion() {
    this.stableDrop = undefined;
    this.sprintLean = 0;
    this.sprintContacts = undefined;
    this.sprintContactTime = undefined;
    this.sprintPeriod = undefined;
    this.reachCorrection = 0;
    this.lastSolveMode=undefined;this.exitBlend=0;this.lastSolvedDrop=undefined;
    for (const leg of this.legs) {
      leg.lastSegmentAngles = undefined;
      leg.solvedSegmentAngles = undefined;
    }
  }

  moveBody(position, groundHeight = 0, yaw = 0) {
    this.body.quaternion.copy(this.bodyRotation).premultiply(new Quaternion().setFromAxisAngle(up, yaw));
    this.body.position.copy(this.bodyOrigin).add(new Vector3(position.x, groundHeight, position.z));
    this.root.updateMatrixWorld(true);
  }

  solve(snapshot, yaw = 0, groundHeight = () => 0, pass = 0) {
    const forward = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    if(pass===0){
      const dt=snapshot.gait?.dt??1/60;
      if(this.lastSolveMode==='dash'&&snapshot.mode!=='dash'){
        this.stableDrop=this.lastSolvedDrop;this.exitBlend=.22;
      }else this.exitBlend=Math.max(0,(this.exitBlend??0)-dt);
      this.sprintLean??=0;
      this.sprintLean+=((snapshot.mode==='sprint'?12*Math.PI/180:0)-this.sprintLean)*(1-Math.exp(-dt/.20));
      const right=new Vector3(Math.cos(yaw),0,-Math.sin(yaw));
      this.body.quaternion.premultiply(new Quaternion().setFromAxisAngle(right,this.sprintLean));
      this.body.position.addScaledVector(forward,.06*this.sprintLean/(12*Math.PI/180));
      this.root.updateMatrixWorld(true);
    }
    const bodyY = this.body.position.y;
    const maxDrop=this.maxPelvisDrop+Math.max(snapshot.mode==='dash'?.10:snapshot.mode==='sprint'?.04:0,.10*(this.exitBlend??0)/.22);
    if (snapshot.gait?.coordinated && !snapshot.lockBody) {
      // Hold the comfortable standing height through the stride. Anticipate
      // the landing target using all three segments, letting the ankle and
      // knee share extension instead of dropping the torso for a fixed ankle.
      let needed = .085;
      if(snapshot.mode==='sprint'){
        if(pass===0){
          const contacts=snapshot.feet.reduce((sum,f)=>sum+f.landings,0);
          if(this.sprintContacts!==contacts){
            const interval=snapshot.time-(this.sprintContactTime??snapshot.time-.35);
            if(interval>.2&&interval<.7)this.sprintPeriod=interval;
            this.sprintContactTime=snapshot.time;this.sprintContacts=contacts;
          }
        }
        const phase=(snapshot.time-(this.sprintContactTime??snapshot.time))/(this.sprintPeriod??.35);
        // Receive and compress after touchdown, rise through push-off, then
        // descend toward the next contact. Swing reach does not set the bounce.
        needed=this.bodyOrigin.y+.04+.018*Math.cos(2*Math.PI*(phase-.20));
      }
      for (const leg of snapshot.mode==='sprint'?[]:this.legs) {
        const foot = snapshot.feet.find(f => f.side === leg.side);
        const hip = worldPosition(leg.thigh);
        const radius = leg.lengths.reduce((a,b)=>a+b,0) * (snapshot.mode==='sprint'?.92:.985);
        for (const [point,remaining] of [[foot.position,0], ...(foot.phase==='swing'&&snapshot.mode!=='sprint'?[[foot.target.ankle,foot.remainingSwingSeconds??0]]:[])]) {
          // Judge touchdown reach from the hip position at touchdown.
          const futureHip=hip.clone().add(new Vector3(snapshot.gait.velocity?.x??0,0,snapshot.gait.velocity?.z??0).multiplyScalar(remaining));
          const target = new Vector3(point.x,point.y,point.z);
          const normal = hingePlane(forward,target.clone().sub(futureHip),leg.axialOffset);
          target.addScaledVector(normal,-leg.axialOffset);
          const horizontal = (futureHip.x-target.x)**2+(futureHip.z-target.z)**2;
          const vertical = Math.sqrt(Math.max(.001,radius*radius-horizontal));
          needed = Math.max(needed,hip.y-target.y-vertical+.005);
        }
      }
      if (pass===0) {
        this.stableDrop ??= needed;
        const time = this.exitBlend>0?.10:snapshot.mode==='sprint'?.012:needed > this.stableDrop?.10:.4;
        this.stableDrop += (needed-this.stableDrop)*(1-Math.exp(-snapshot.gait.dt/time));
      }
      this.body.position.y -= Math.min(maxDrop,this.stableDrop);
      this.root.updateMatrixWorld(true);
    }
    for (let iteration = 0; iteration < (snapshot.gait?.coordinated ? 0 : 4); iteration++) {
      let drop = 0;
      for (const leg of this.legs) {
        const foot = snapshot.feet.find(f => f.side === leg.side);
      const turn = foot.phase === 'swing' && foot.target
        ? Math.atan2(Math.sin(foot.target.yaw - foot.yaw), Math.cos(foot.target.yaw - foot.yaw)) * (foot.progress * foot.progress * (3 - 2 * foot.progress)) : 0;
      const footYaw = foot.yaw + turn;
      const forward = new Vector3(Math.sin(footYaw), 0, Math.cos(footYaw));
        const target = new Vector3(foot.position.x, foot.position.y, foot.position.z);
        const hip = worldPosition(leg.thigh);
        const normal = hingePlane(forward, target.clone().sub(hip), leg.axialOffset);
        target.addScaledVector(normal, -leg.axialOffset);
        const tangent = forward.clone().addScaledVector(normal, -forward.dot(normal)).normalize();
        const down = new Vector3().crossVectors(normal, tangent).normalize();
        if (down.y > 0) down.negate();
        const lower = tangent.multiplyScalar(.65).addScaledVector(down, .76).normalize();
        const hock = target.addScaledVector(lower, -leg.lengths[2]);
        const radius = (leg.lengths[0] + leg.lengths[1]) * .98;
        const horizontal = (hip.x - hock.x) ** 2 + (hip.z - hock.z) ** 2;
        const vertical = Math.sqrt(Math.max(.001, radius * radius - horizontal));
        drop = Math.max(drop, hip.y - hock.y - vertical);
      }
      const remaining = maxDrop - (bodyY - this.body.position.y);
      this.body.position.y -= Math.max(0, Math.min(remaining, drop));
      this.root.updateMatrixWorld(true);
    }
    // Fit the pelvis to the simultaneous contact constraints. Vertical-only
    // compensation cannot reach a trailing foot during a diagonal transition.
    // Resolve the small residual in 3D instead of twisting or stretching joints.
    if (snapshot.mode === 'sprint' || snapshot.mode === 'dash' || this.sprintLean > .0001 || this.exitBlend > 0) {
      const origin=this.body.position.clone();
      for(let iteration=0;iteration<12;iteration++) {
        let worst=0;
        for(const leg of this.legs) {
          const foot=snapshot.feet.find(f=>f.side===leg.side);
          const delta=new Vector3(foot.position.x,foot.position.y,foot.position.z).sub(worldPosition(leg.thigh));
          const turn=foot.phase==='swing'&&foot.target?Math.atan2(Math.sin(foot.target.yaw-foot.yaw),Math.cos(foot.target.yaw-foot.yaw))*(foot.progress*foot.progress*(3-2*foot.progress)):0;
          const footForward=new Vector3(Math.sin(foot.yaw+turn),0,Math.cos(foot.yaw+turn));
          const across=delta.clone().addScaledVector(footForward,-delta.dot(footForward));
          const axisClearance=Math.abs(leg.axialOffset)+.003;
          if(across.length()<axisClearance){
            const correction=axisClearance-across.length();
            this.body.position.addScaledVector(across.normalize(),-correction);
            this.root.updateMatrixWorld(true);worst=Math.max(worst,correction);
            delta.set(foot.position.x,foot.position.y,foot.position.z).sub(worldPosition(leg.thigh));
          }
          const radius=leg.lengths.reduce((a,b)=>a+b,0)-(snapshot.mode==='sprint'?.03:.004);
          const distance=delta.length();
          const minimum=Math.max(.20,Math.abs(leg.axialOffset)+.04);
          if(distance<minimum){this.body.position.addScaledVector(delta.clone().normalize(),distance-minimum);this.root.updateMatrixWorld(true);worst=Math.max(worst,minimum-distance);}
          const excess=distance-radius;
          if(excess>0){this.body.position.addScaledVector(delta.normalize(),excess);this.root.updateMatrixWorld(true);worst=Math.max(worst,excess);}
        }
        if(worst<.0001)break;
      }
      this.reachCorrection=this.body.position.clone().sub(origin).length();
    }
    const results = [];
    for (const leg of this.legs) {
      const foot = snapshot.feet.find(f => f.side === leg.side);
      const turn = foot.phase === 'swing' && foot.target
        ? Math.atan2(Math.sin(foot.target.yaw - foot.yaw), Math.cos(foot.target.yaw - foot.yaw)) * (foot.progress * foot.progress * (3 - 2 * foot.progress)) : 0;
      const footYaw = foot.yaw + turn;
      const forward = new Vector3(Math.sin(footYaw), 0, Math.cos(footYaw));
      const target = new Vector3(foot.position.x, foot.position.y, foot.position.z);
      const hip = worldPosition(leg.thigh), hipToFoot = target.clone().sub(hip);
      const normal = hingePlane(forward, hipToFoot, leg.axialOffset);
      const planarTarget = target.clone().addScaledVector(normal, -leg.axialOffset);
      const planeForward = forward.clone().addScaledVector(normal, -forward.dot(normal)).normalize();
      const planeDown = new Vector3().crossVectors(normal, planeForward).normalize();
      if (planeDown.dot(up) > 0) planeDown.negate();
      // The short original ankle remains forward/down; no bone length changes.
      const lowerDirection = planeForward.clone().multiplyScalar(0.65).addScaledVector(planeDown, 0.76).normalize();
      // At the reach boundary, extend the ankle within the same hinge plane
      // before clamping the leg. Its normal posture is a preference, not a lock.
      const reach = leg.lengths[0] + leg.lengths[1] - (snapshot.mode==='sprint'?.025:.001);
      const ankleDelta = planarTarget.clone().sub(hip);
      if (ankleDelta.clone().addScaledVector(lowerDirection, -leg.lengths[2]).length() > reach) {
        const extended = ankleDelta.clone().normalize();
        let low = 0, high = 1;
        for (let i = 0; i < 20; i++) {
          const blend = (low + high) / 2;
          const direction = lowerDirection.clone().lerp(extended, blend).normalize();
          if (ankleDelta.clone().addScaledVector(direction, -leg.lengths[2]).length() > reach) low = blend;
          else high = blend;
        }
        lowerDirection.lerp(extended, high).normalize();
      }
      const minimumReach=Math.abs(leg.lengths[0]-leg.lengths[1])+.001;
      if(ankleDelta.clone().addScaledVector(lowerDirection,-leg.lengths[2]).length()<minimumReach){
        const folded=ankleDelta.clone().normalize().negate();
        let low=0,high=1;
        for(let i=0;i<20;i++){
          const amount=(low+high)/2;
          const direction=lowerDirection.clone().lerp(folded,amount).normalize();
          if(ankleDelta.clone().addScaledVector(direction,-leg.lengths[2]).length()<minimumReach)low=amount;else high=amount;
        }
        lowerDirection.lerp(folded,high).normalize();
      }
      const hock = planarTarget.clone().addScaledVector(lowerDirection, -leg.lengths[2]);
      const delta = hock.clone().sub(hip), rawDistance = delta.length();
      const [a, b] = leg.lengths;
      const d = Math.max(Math.abs(a - b) + 1e-4, Math.min(a + b - 1e-4, rawDistance));
      const along = delta.normalize();
      const bend = planeForward.clone().addScaledVector(along, -planeForward.dot(along)).normalize();
      const x = (a * a - b * b + d * d) / (2 * d);
      let knee = hip.clone().addScaledVector(along, x)
        .addScaledVector(bend, Math.sqrt(Math.max(0, a * a - x * x)));
      let solvedHock = hip.clone().addScaledVector(along, d);
      if(snapshot.mode==='sprint'||snapshot.mode==='drag'){
        const angleOf=v=>Math.atan2(v.dot(planeForward),v.dot(planeDown));
        const difference=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
        const preferred=[angleOf(knee.clone().sub(hip)),angleOf(solvedHock.clone().sub(knee)),angleOf(lowerDirection)];
        const prior=leg.lastSegmentAngles??preferred;
        const r=ankleDelta.length(),c=leg.lengths[2];
        const targetAngle=angleOf(ankleDelta);
        const thetaMin=Math.acos(Math.max(-1,Math.min(1,(r*r+a*a-(b-c+.001)**2)/(2*r*a))));
        const thetaMax=Math.acos(Math.max(-1,Math.min(1,(r*r+a*a-(b+c-.001)**2)/(2*r*a))));
        // The redundant ankle lets us choose the exact-contact solution with
        // the least angular change across the whole chain, not just the thigh.
        let best;
        const evaluate=angle=>{
          const candidateKnee=hip.clone().addScaledVector(planeForward,a*Math.sin(angle)).addScaledVector(planeDown,a*Math.cos(angle));
          const remaining=planarTarget.clone().sub(candidateKnee),distance=remaining.length(),direction=remaining.clone().normalize();
          const axis=planeForward.clone().addScaledVector(direction,-planeForward.dot(direction)).normalize();
          const length=(b*b-c*c+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,b*b-length*length));
          for(const sign of [-1,1]){
            const candidateHock=candidateKnee.clone().addScaledVector(direction,length).addScaledVector(axis,sign*height);
            const angles=[angle,angleOf(candidateHock.clone().sub(candidateKnee)),angleOf(planarTarget.clone().sub(candidateHock))];
            const changes=angles.map((v,i)=>difference(v,prior[i]));
            const posture=angles.map((v,i)=>difference(v,preferred[i]));
            const cost=changes.reduce((sum,v)=>sum+v*v,0)+2*Math.max(...changes.map(v=>v*v))+.08*posture.reduce((sum,v)=>sum+v*v,0);
            if(!best||cost<best.cost)best={cost,angle,knee:candidateKnee,hock:candidateHock,angles};
          }
        };
        const low=targetAngle+thetaMin,high=targetAngle+thetaMax;
        for(let i=0;i<=48;i++)evaluate(low+(high-low)*i/48);
        const center=best.angle,step=(high-low)/48;
        for(let i=-8;i<=8;i++)evaluate(Math.max(low,Math.min(high,center+step*i/8)));
        knee=best.knee;solvedHock=best.hock;
        lowerDirection.copy(planarTarget).sub(solvedHock).normalize();
        leg.solvedSegmentAngles=best.angles;
      }else leg.solvedSegmentAngles=undefined;
      const directions = [knee.clone().sub(hip), solvedHock.clone().sub(knee), lowerDirection];
      leg.references.forEach((ref, i) => setWorldRotation(ref.node,
        basis(directions[i], normal).multiply(ref.offset)));
      const contact = foot.phase === 'stance' ? foot.contact : foot.target;
      const slope = contact ? Math.atan2(contact.toe.y - contact.heel.y, 0.22) : 0;
      const pitch = slope - (foot.dragPose?.pitch ?? foot.sprintPose?.pitch ?? (foot.phase === 'swing' ? .35*Math.sin(Math.PI*foot.progress) : 0));
      const footDirection = planeForward.clone().applyAxisAngle(normal, -pitch);
      leg.footRefs.forEach(ref => setWorldRotation(ref.node, basis(footDirection, normal).multiply(ref.offset)));
      articulateContact(leg.toe, normal, groundHeight, foot.phase === 'stance' || foot.sprintPose?.toeContact, Math.abs(slope) < .001);
      const trailing = hip.clone().sub(target).dot(planeForward);
      // Roll off the trailing heel in both walking and sprinting. The toe
      // remains independently grounded while the heel is allowed to rise.
      const heelLift = foot.phase === 'stance' && snapshot.mode === 'walk'
        ? Math.max(0, Math.min(snapshot.mode === 'sprint' ? .45 : .28, (trailing - .025) * 8)) : 0;
      if (heelLift > 0) articulateContact(leg.heel, normal, groundHeight, true);
      if (heelLift > 0) setWorldRotation(leg.heel, new Quaternion().setFromAxisAngle(normal, heelLift).multiply(worldRotation(leg.heel)));
      articulateContact(leg.heel, normal, groundHeight, foot.phase === 'stance' && heelLift === 0 && !(foot.sprintPose?.pitch > .01));
      const error = worldPosition(leg.ball).distanceTo(target);
      results.push({ side: leg.side, error, target: target.toArray(), clearanceLift: foot.clearanceLift ?? 0,
        hipDistance:hipToFoot.length(), axialOffset:leg.axialOffset, lengths:leg.lengths, heelLift, toeClearance: meshClearance(leg.toe, groundHeight), heelClearance: meshClearance(leg.heel, groundHeight),
        clearance: Math.min(meshClearance(leg.ball, groundHeight), meshClearance(leg.heel, groundHeight), meshClearance(leg.toe, groundHeight)), reachClamped: Math.abs(d - rawDistance) > 0.001 });
    }
    const toeSupport=result=>snapshot.feet.find(f=>f.side===result.side)?.sprintPose?.toeContact;
    if (pass < 3 && results.some(result => result.clearance < .001 || (toeSupport(result) && result.toeClearance > .005))) {
      const adjusted = structuredClone(snapshot);
      for (const result of results) {
        if (result.clearance >= .001 && !(toeSupport(result) && result.toeClearance > .005)) continue;
        const foot = adjusted.feet.find(f => f.side === result.side);
        const lift = result.clearance < .001 ? Math.min(.04, .003 - result.clearance) : -Math.min(.04,result.toeClearance-.002);
        foot.position.y += lift;
        foot.clearanceLift = (foot.clearanceLift ?? 0) + lift;
      }
      this.body.position.y = bodyY;
      this.root.updateMatrixWorld(true);
      return this.solve(adjusted, yaw, groundHeight, pass + 1);
    }
    this.lastSolveMode=snapshot.mode;this.lastSolvedDrop=bodyY-this.body.position.y;
    for(const leg of this.legs)leg.lastSegmentAngles=leg.solvedSegmentAngles;
    return results;
  }
}
