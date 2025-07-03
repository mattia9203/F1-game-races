// src/loader/CarLoader.js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export class CarLoader {
  constructor(path) {
    this.loader = new GLTFLoader();
    this.path = path;
  }
  async load() {
    const gltf = await this.loader.loadAsync(this.path);
    const car = gltf.scene;
    car.scale.setScalar(0.5);
    return car;
  }
}
