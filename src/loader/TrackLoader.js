// src/loader/TrackLoader.js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export class TrackLoader {
  constructor(path) {
    this.path = path;
    this.loader = new GLTFLoader();
  }
  async load() {
    const gltf = await this.loader.loadAsync(this.path);
    const scene = gltf.scene;
    // hard-coded waypoints for now; later you can read empties from the .glb
    const waypoints = [
      [0,0,0], [10,0,0], [10,0,-10], [0,0,-10],
      [-10,0,-10], [-10,0,0], [-10,0,10], [0,0,10],
      [10,0,10], [0,0,0]
    ].map(arr => new THREE.Vector3(...arr));
    return { scene, waypoints };
  }
}
