import * as THREE from 'three';
import { OrbitControls }    from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }       from 'three/examples/jsm/loaders/GLTFLoader.js';
import { emissive } from 'three/tsl';

const platformPosition = new THREE.Vector3(2, 0, 0);
const platformHeight   = 0.3;   // cylinder height
let scene, camera, renderer, controls, carModel, baseCarY, flickerTarget;
let sweepLight, sweepStartTime = null, steamStartTime, bounceStartTime, spinStartTime;
let logoMesh, backWallMaterial, keyLight, ringMesh;
let orbitAngle      = 0;
let lastInteraction = 0;
const idleDelay     = 5000;    // 5 seconds
const orbitRadius   = 6;       // circle radius
const orbitSpeed    = 0.000001;  // radians per ms (tweak for speed)
let initialCamPos, initialCamTarget;
let steamParticles
let wheels = [];

// Glow settings
const glowAmp = 0.3;
const glowFreq = 1.0;


export function launchGarage() {
  const canvas = document.getElementById('gameCanvas');
  canvas.style.display = 'block';

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;

  // Scene & Camera
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 100);
  camera.position.set(4, 2, 4);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(2, 0.5, 0);
  controls.enableDamping = true;
  controls.update();

   // start the idle timer
  lastInteraction = performance.now();

  // any user input resets the timer
  ['pointerdown','wheel','keydown','touchstart'].forEach(evt =>
    window.addEventListener(evt, () => {
      lastInteraction = performance.now();
      // snap back to home camera view
    })
  );


  // 1) Key Light (Directional)
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(5, 10, 7);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(keyLight);

  // Sweep Light (Spot)
  sweepLight = new THREE.SpotLight(0xffffff, 2, 15, Math.PI/8, 0.2);
  sweepLight.position.set(2, 10, -5);
  sweepLight.target.position.copy(platformPosition);
  sweepLight.castShadow = false;
  sweepLight.visible = false;
  scene.add(sweepLight, sweepLight.target);

  // Fill & Ambient
  scene.add(new THREE.HemisphereLight(0x444444, 0x222222, 0.6));
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));


  // Floor & walls
  createGarageRoom();
  // UI + default car
  setupTeamSelector();
  initialCamPos    = camera.position.clone();
  initialCamTarget = controls.target.clone();
  loadTeamCar('f1');
  // reset interaction timer
  lastInteraction = performance.now();

  // any user action resets the timer
  ['pointerdown', 'wheel', 'keydown', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, () => {
      lastInteraction = performance.now();
      orbitAngle = 0; // optional: restart orbit from front
    });
  });
  
  animate(); 
}

function createGarageRoom() {
  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.3, roughness: 0.7 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Back Wall
  backWallMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(20, 5, 0.1),
    backWallMaterial
  );
  backWall.position.set(0, 2.5, -10);
  scene.add(backWall);

  // Ceiling
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x111111 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 5;
  scene.add(ceiling);


  // Platform
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(2.3, 2.3, platformHeight, 32),
    new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.4, roughness: 0.4 })
  );
  platform.position.copy(platformPosition).setY(platformHeight / 2);
  platform.receiveShadow = true;
  scene.add(platform);

  // Logo panel on the left wall
  const panelGeo = new THREE.PlaneGeometry(4, 2.5);
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.5,
    side: THREE.DoubleSide,
    transparent : true,
    alphaTest: 0.1
  });

  logoMesh = new THREE.Mesh(panelGeo, panelMat);
  // Position it flush against the left wall (x = -10), at eye height
  logoMesh.position.set(-10, 2.5, -6);  // tiny offset so it doesn’t z-fight the wall
  logoMesh.rotation.y = Math.PI / 2;         // face into the room
  scene.add(logoMesh);

  const ringGeo = new THREE.TorusGeometry(2.5, 0.05, 16, 100);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x00ffff,
    emissive: 0x00ffff,
    emissiveIntensity: 1.2,
    metalness: 0.3,
  });
  ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.position.copy(platformPosition).setY(platformHeight / 2 + 0.01);
  ringMesh.rotation.x = Math.PI / 2;
  scene.add(ringMesh);
}




function setupTeamSelector() {
  const ui = document.createElement('div');
  ui.className = 'garage-ui';
  document.body.appendChild(ui);

  const teams = ['ferrari', 'redbull', 'mercedes', 'aston_martin', 'alpine', 'alphatauri'];
  teams.forEach(team => {
    const img = document.createElement('img');
    img.src = `/assets/logos/${team}.png`;
    img.alt = team;
    img.onclick = () => loadTeamCar(team);
    ui.appendChild(img);
  });
}

  // ── TRIGGER OUR SELECTION ANIM ────────────────────────────────────────────────
  // once the new car is in the scene, kick off steam, bounce & spin
function triggerSelectAnim() {
  // capture wheels & base Y
  wheels = [];
  carModel.traverse(o => o.name.includes('tyre_') && wheels.push(o));
  baseCarY = carModel.position.y;
  sweepStartTime = performance.now();
  sweepLight.visible = true;
}


function loadTeamCar(name) {
  const loader = new GLTFLoader();
  const path   = `/assets/cars/${name}.glb`;
  orbitAngle = 0;
  camera.position.copy(initialCamPos);
  camera.lookAt(initialCamTarget);

  loader.load(path, (gltf) => {
    // remove old
    if (carModel) {
      scene.remove(carModel);
      carModel.traverse(o => {
        if (o.isMesh) {
          o.geometry.dispose();
          o.material.dispose();
        }
      });
    }

    carModel = gltf.scene;
    triggerSelectAnim();
    // 1) Normalize & scale
    const box = new THREE.Box3().setFromObject(carModel);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 2 / maxDim;
    carModel.scale.setScalar(scale);

    // 2) Center and lift so wheels rest on top of platform
    const center = box.getCenter(new THREE.Vector3());
    carModel.position.copy(platformPosition)
      .sub(center.multiplyScalar(scale))
      .setY(platformHeight + (size.y * scale) / 2);

    // 3) Shadows
    carModel.traverse(o => o.isMesh && (o.castShadow = true));
    scene.add(carModel);

    // 4) Re-target controls
    controls.target.copy(platformPosition)
      .setY(platformHeight + (size.y * scale) / 2);
    controls.update();

    // 5) Theme the back wall
    const teamColors = {
      ferrari:    0xFF0000, // red
      redbull:    0x1a1aff, // blue
      aston_martin: 0x006f4f, // Aston Martin green
      mercedes:   0x00d2be, // Mercedes sky-teal
      alphatauri: 0x2b4562, // AlphaTauri deep blue
      alpine:     0x0090ff, // Alpine muted sky-blue
      car:        0x444444  // default grey
    };
    backWallMaterial.color.setHex(teamColors[name] || 0x333333);

    // 6) Update left-wall logo
    const texLoader = new THREE.TextureLoader();
    const logoPath = `/assets/logos/${name}.png`;
    texLoader.load(logoPath, (tex) => {
      logoMesh.material.map = tex;
      logoMesh.material.emissiveMap= tex;
      logoMesh.material.emissive.setHex(0xffffff);
      logoMesh.material.needsUpdate = true;
    });

    ringMesh.material.color.setHex(teamColors[name]);
    ringMesh.material.emissive.setHex(teamColors[name]);


    // 7) Flicker target
    flickerTarget = keyLight;
  });
}

const bobAmp = 0.02, bobFreq = 2.5;
const vibAmp = THREE.MathUtils.degToRad(1.5), vibFreq = 2.2;
let now;
  // ── TRIGGER OUR SELECTION ANIM ────────────────────────────────────────────────
 // once the new car is in the scene, kick off steam, bounce & spin


 
function animate(time) {
  requestAnimationFrame(animate);

  now = performance.now();


  if (carModel) {
  const t = time * 0.001;
  carModel.position.y = platformHeight + Math.sin(t * bobFreq) * bobAmp;
  carModel.rotation.y += Math.sin(t * vibFreq) * vibAmp * 0.001;
}
  now   = time;
  const idle  = now - lastInteraction;

  if (idle > idleDelay) {
    // compute delta since last frame
    const dt = idle - (idle - (now - lastInteraction));
    // advance orbit
    orbitAngle += orbitSpeed * dt;

    // position camera on a horizontal circle
    const x = platformPosition.x + Math.cos(orbitAngle) * orbitRadius;
    const z = platformPosition.z + Math.sin(orbitAngle) * orbitRadius;
    camera.position.set(x, camera.position.y, z);

    // look at the car’s center height
    const carBox = new THREE.Box3().setFromObject(carModel);
    const carSize = carBox.getSize(new THREE.Vector3());
    const lookY = platformHeight + (carSize.y * carModel.scale.y) / 2;
    camera.lookAt(platformPosition.x, lookY, platformPosition.z);
  }
  // Spotlight sweep animation over 1s
  if (sweepStartTime) {
    const t = (now - sweepStartTime) / 1000;
    const angle = Math.PI * Math.min(t, 1);
    const x = platformPosition.x + Math.cos(angle) * 8;
    const z = platformPosition.z + Math.sin(angle) * 8;
    sweepLight.position.set(x, 8, z);
    sweepLight.target.position.copy(carModel.position);
    if (t > 1) sweepLight.visible = false;
  }

  // Logo glow
  const glow = 0.5 + glowAmp * Math.sin(time * 0.001 * glowFreq * Math.PI * 2);
  logoMesh.material.emissiveIntensity = glow;

  controls.update();
  renderer.render(scene, camera);
}



