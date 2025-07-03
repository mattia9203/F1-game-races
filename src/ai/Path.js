// src/ai/Path.js
import * as THREE from 'three';
export class Path {
  constructor(points, closed = true) {
    this.curve = new THREE.CatmullRomCurve3(points, closed);
  }
  getPoint(t) { return this.curve.getPointAt(t); }
  getTangent(t) { return this.curve.getTangentAt(t); }
}
