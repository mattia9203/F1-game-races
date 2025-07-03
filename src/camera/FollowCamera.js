// src/camera/FollowCamera.js
import * as THREE from 'three';
export class FollowCamera {
  constructor(camera, target, offset = new THREE.Vector3(0,5,10)) {
    this.camera = camera;
    this.target = target;
    this.offset = offset;
    this.tmp = new THREE.Vector3();
  }
  update() {
    // desired position = target position + offset in world coords
    this.tmp.copy(this.offset).applyQuaternion(this.target.quaternion);
    this.camera.position.lerp(this.target.position.clone().add(this.tmp), 0.1);
    this.camera.lookAt(this.target.position);
  }
}
