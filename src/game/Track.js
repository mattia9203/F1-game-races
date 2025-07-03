// src/game/Track.js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export class Track {
  constructor({ name, path, startPos }) {
    this.name     = name;
    this.path     = path;
    this.startPos = startPos;
    this.mesh     = null;
  }

  async load() {
    const loader = new GLTFLoader();
    const gltf   = await loader.loadAsync(this.path);
    this.mesh    = gltf.scene;
    // apply shadows, collision, whatever
    return this.mesh;
  }
}