import {Object3D,Matrix4,Quaternion,Vector3} from 'three';

// Weapon owns the immutable grip frames. Arm IK consumes their world transforms.
export class WeaponGripRig {
  constructor(root,waist,weapon,hands,leftLift){
    this.root=root;this.waist=waist;this.weapon=weapon;
    root.updateMatrixWorld(true);
    this.control=new Object3D();this.control.name='CTRL_weapon';waist.add(this.control);
    this.control.matrix.copy(waist.matrixWorld.clone().invert().multiply(weapon.matrixWorld));
    this.control.matrix.decompose(this.control.position,this.control.quaternion,this.control.scale);
    this.control.updateWorldMatrix(true,false);this.control.attach(weapon);
    this.bind=this.control.matrix.clone();
    this.grips=hands.map((hand,i)=>{
      const anchor=new Object3D();anchor.name=i===0?'GRIP_foregrip':'GRIP_trigger';
      const world=hand.matrixWorld.clone();
      if(i===0)world.setPosition(hand.getWorldPosition(new Vector3()).add(leftLift.clone().applyQuaternion(weapon.getWorldQuaternion(new Quaternion()))));
      weapon.add(anchor);anchor.matrix.copy(weapon.matrixWorld.clone().invert().multiply(world));
      anchor.matrix.decompose(anchor.position,anchor.quaternion,anchor.scale);return anchor;
    });
    this.scopeSight=new Object3D();this.scopeSight.name='SIGHT_scope';weapon.add(this.scopeSight);
    this.scopeSight.position.copy(this.grips[1].position).add(new Vector3(0,.04,0));
  }
  resetPose(){this.bind.decompose(this.control.position,this.control.quaternion,this.control.scale);this.root.updateMatrixWorld(true);}
  worldMatrix(){this.root.updateMatrixWorld(true);return this.control.matrixWorld.clone();}
  setWorld(matrix){
    this.control.parent.updateWorldMatrix(true,false);
    const local=new Matrix4().copy(this.control.parent.matrixWorld).invert().multiply(matrix);
    local.decompose(this.control.position,this.control.quaternion,this.control.scale);this.root.updateMatrixWorld(true);
  }
  translateWorld(delta){const matrix=this.worldMatrix();matrix.setPosition(new Vector3().setFromMatrixPosition(matrix).add(delta));this.setWorld(matrix);}
  rotateAround(center,rotation){
    const matrix=this.worldMatrix(),p=new Vector3(),q=new Quaternion(),s=new Vector3();matrix.decompose(p,q,s);
    p.sub(center).applyQuaternion(rotation).add(center);q.premultiply(rotation);
    this.setWorld(new Matrix4().compose(p,q,s));
  }
  targets(){this.root.updateMatrixWorld(true);return this.grips.map(anchor=>({position:anchor.getWorldPosition(new Vector3()),rotation:anchor.getWorldQuaternion(new Quaternion())}));}
}
