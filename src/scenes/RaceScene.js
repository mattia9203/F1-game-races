// src/scenes/RaceScene.js

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyCarPhysics } from './physics.js';
import { initAudio, updateAudio, playCollision} from '../AudioEngine.js';
//import { Track } from '../game/Track.js';
import { tracks } from '../config.js';
import { Sky }          from 'three/examples/jsm/objects/Sky.js';
import { and, step } from 'three/tsl';

const canvasId       = 'gameCanvas';
const driveKeys      = { KeyW:0, KeyS:0, KeyA:0, KeyD:0 };
const localCamOffset = new THREE.Vector3(0, 2.5, -5.3);
const clock = new THREE.Clock();          // for real-time Δt

// Physics state & config
let physicsState = {
  velocity       : 0,
  steerAngle     : 0,
  lastWallNormal : null,   // THREE.Vector3
  lastWallOffset : 0,
  yawAngle : 0
};

const physicsConfig = {
  maxSpeed   : 95,
  brakeDecel : 55,
  friction   : 0.9992,
  maxSteer   : THREE.MathUtils.degToRad(20),
  steerSpeed : THREE.MathUtils.degToRad(160)  // °/s  how fast you can turn wheel
};

// Raycaster for ground detection
const downRay = new THREE.Raycaster();
const downDir = new THREE.Vector3(0, -1, 0);

let scene, camera, renderer;
let trackModel = null, carModel = null;
let sun, sky, pmremGen;
let sunDir       = new THREE.Vector3();  // unit vector from target → sun
let sunDistance  = 120;                  // how far the sun sits away

// Frustum half-size (metres)
// shrink / enlarge for sharper or wider coverage
const SHADOW_R   = 24;

const selectedTrackIndex = 0;
const selectedTrack = tracks[selectedTrackIndex];  // [x, baseY, z]
let wheels = [];


const wallMeshes      = [];        // <Mesh> that really are barriers
const tyreRaycaster   = new THREE.Raycaster();
const _hits           = [];        // scratch array – reused every frame

/* ─── global axis helpers ────────────────────────────────────────── */
const AXIS_Y = new THREE.Vector3(0, 1, 0);   // world-up unit vector
const WALL_EPS = 0.06;           // 6 cm
let lastGear = 0;
let hudGear, hudRPM, hudSpeed, hudLapCur, hudLapBest;

// ─────────────────────────────────────────────────────────────────────────────
let startPos      = new THREE.Vector3();
let startNormal   = new THREE.Vector3();
let prevSide      = 0;               // sign() of last frame
let lapStartT     = 0;               // ms
let bestLapT      = null;            // ms
let lapFlashTimer = 0;               // sec left before bar colour resets
let trackRoad;
let lapActive = false;
const FINISH_X =-28;


export function launchRace() {
  initRenderer();
  initScene();
  initAudio(camera);
  loadTrack(selectedTrack);
  loadCar(selectedTrack);
  setupInput();
  window.addEventListener('resize', onWindowResize);
  animate();
}

function initRenderer() {
  const canvas = document.getElementById(canvasId);
  canvas.style.display = 'block';
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

  // Physically-based tone mapping looks better with HDR sky
  renderer.toneMapping        = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.7;

  // PMREM generator for environment reflections
  pmremGen = new THREE.PMREMGenerator(renderer);
}



function initScene() {
  scene = new THREE.Scene();
  //scene.background = new THREE.Color(0x222222);

  // camera
  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  // ambient fill
  scene.add(new THREE.AmbientLight(0x888888,0.35));

  hudGear = document.querySelector('#hud .gear');
  hudRPM  = document.querySelector('#hud .rpm');
  hudSpeed = document.querySelector('#hud .speed');
  hudLapCur = document.getElementById('lapCur');
  hudLapBest = document.getElementById('lapBest');
  const hud =document.getElementById ('hud');
  hud.style.display = 'block';

  // hemisphere sky‐color for a bit of top/bottom tint
    // optional low-intensity hemi fill (keep it subtle)
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.005);
  scene.add(hemi);

  // — Sunlight with shadows —

  sun = new THREE.DirectionalLight(0xffffff, 3.3);
  // position will be set **after** Sky is configured

  sun.castShadow = true;

  // --- shadow-map quality -------------------------------------------------
  sun.shadow.radius  = 1;    // smaller PCF kernel = sharper & darker edges
  sun.shadow.mapSize.set(4096, 4096);

  // --- orthographic frustum ----------------------------------------------
  const s = SHADOW_R;                      // half-size in metres
  const cam = sun.shadow.camera;
  cam.left   = -s;
  cam.right  =  s;
  cam.top    =  s;
  cam.bottom = -s;
  cam.near   =  0.5;
  cam.far    =  sunDistance + 20;                     // give it some depth
  cam.updateProjectionMatrix();            // IMPORTANT
  
  sun.shadow.bias       = -0.0004;   // push shadow *into* the receiver
  sun.shadow.normalBias =  0.015;    // just enough to kill acne
  sun.shadow.radius     =  3;        // small kernel blur (PCF only)

  scene.add(sun);

  // You can uncomment to visualize the shadow frustum:
  // const helper = new THREE.CameraHelper(sun.shadow.camera);
  // scene.add(helper);

  sky = new Sky();
  sky.scale.setScalar(10000);  // gigantic dome
  scene.add(sky);

  const skyUniforms = sky.material.uniforms;
  // ↓ tweak these to taste
  skyUniforms.turbidity.value        = 10;
  skyUniforms.rayleigh.value         = 3;
  skyUniforms.mieCoefficient.value   = 0.005;
  skyUniforms.mieDirectionalG.value  = 0.95;

  // Sun position in spherical coords (deg)
  const opts = { elevation: 50, azimuth: 140 };  // tweak freely
  const phi   = THREE.MathUtils.degToRad(90 - opts.elevation);
  const theta = THREE.MathUtils.degToRad(opts.azimuth);
  // Same direction for both the Sky shader and the shadow light
  sun.position.setFromSphericalCoords(1, phi, theta).multiplyScalar(100);
  skyUniforms.sunPosition.value.copy(sun.position);
  // Cache sun direction & distance for the “chase” update
  sunDir.copy(sun.position).normalize();
  sunDistance = sun.position.length();

  // Build an HDR environment from the sky for PBR reflections
  const envRT = pmremGen.fromScene(sky);
  scene.environment = envRT.texture;   // materials get glossy reflections
  scene.background  = envRT.texture;   // tone-mapped sky in the BG

  // Dispose the generator; no longer needed
  pmremGen.dispose();
}

function updateSunShadow() {
  if (!carModel || !sun) return;
  // slide the light with the player
  sun.position.copy(sunDir).multiplyScalar(sunDistance).add(carModel.position);
  sun.target.position.copy(carModel.position);
  sun.target.updateMatrixWorld();

  const cam = sun.shadow.camera;
  cam.near = 0.5;
  cam.far  = sunDistance + 10;
  const pad = 6;                         // metres of slack around the car
  cam.left = cam.bottom = -pad;
  cam.right = cam.top   =  pad;
  cam.updateProjectionMatrix();
}

function loadTrack(trackInfo) {
  const loader = new GLTFLoader();

  // unload previous track if one exists
  if (trackModel) {
    scene.remove(trackModel);
    // optionally dispose geometries/materials…
  }

  loader.load(trackInfo.path, gltf => {
    trackModel = gltf.scene;

    trackModel.traverse(o => {
      if (o.isMesh) {
        o.receiveShadow = true;
        o.castShadow    = false;
        o.material.side = THREE.DoubleSide;
      }
    });

    scene.add(trackModel);
    prevSide = 0;                      // forget any old side
    lapStartT = performance.now();     // we’ll ignore the 1st “partial” lap
    trackModel.traverse(o => {
    if (!o.isMesh) return;
      if (/wall|barrier|fence/i.test(o.name)) {
        wallMeshes.push(o);                  // keep the mesh itself
      }
    });
    trackRoad = (() => {
      let hit=null;
      trackModel.traverse(o=>{
        if(!hit && /road/i.test(o.name) && o.isMesh) hit=o;
      });
      return hit;
    })();  
  });
  startPos.set(FINISH_X,0,0);
  startNormal.set(1,1,0);
}


function millisToClock(ms) {
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const ms3 = Math.floor(ms % 1000).toString().padStart(3, '0');
  return `${mm}:${ss.toString().padStart(2,'0')}.${ms3}`;
}

function loadCar(trackInfo) {
  const loader = new GLTFLoader();

  // remove any previous car
  if (carModel) scene.remove(carModel);

  loader.load('/assets/cars/ferrari.glb', gltf => {
    carModel = gltf.scene;
    scene.add(carModel);
    /* ─ Orientation & scale ─────────────────────────────────────────── */
    carModel.rotation.y = -(Math.PI / 2);
    const bb   = new THREE.Box3().setFromObject(carModel);
    const size = bb.getSize(new THREE.Vector3());
    const s    = 4 / Math.max(size.x, size.y, size.z);
    carModel.scale.setScalar(s);

    /* ─ Position the chassis so its wheels rest on Y = ground ────────── */
    const halfH = (size.y * s) / 2;
    carModel.position.set(
      trackInfo.startPos[0],
      trackInfo.startPos[1] + halfH,
      trackInfo.startPos[2]
    );

    /* ─ Build the wheel pivots ───────────────────────────────────────── */
    const wheelSpec = [
      { name: 'tyre_FL', front: true  },
      { name: 'tyre_FR', front: true  },
      { name: 'tyre_RL', front: false },
      { name: 'tyre_RR', front: false }
    ];
  
    wheelSpec.forEach(spec => {
      const mesh = carModel.getObjectByName(spec.name);
      if (!mesh) {
        console.warn('Wheel not found:', spec.name);
        return;
      }

      // 1) Ensure mesh world matrix is up-to-date
      mesh.updateMatrixWorld();
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      const worldCentre = mesh.geometry.boundingBox
                     .getCenter( new THREE.Vector3() )
                     .applyMatrix4( mesh.matrixWorld );   // true hub (world)
      
 
      // 4) Create a pivot Object3D at that point and add under carModel
      const pivot = new THREE.Object3D();
      pivot.position.copy(carModel.worldToLocal(worldCentre.clone()));
      carModel.add(pivot);
      mesh.position.subVectors(mesh.position,pivot.position);

      // 5) Reparent the mesh so its origin sits exactly at the pivot
      //    (we compute the mesh’s local offset by reversing the pivot transform)
      
      pivot.add(mesh);
      mesh.geometry.computeBoundingSphere();
      mesh.updateMatrixWorld();  // ensure world‐matrix matches the pivot
      mesh.frustumCulled = false;
      const name = spec.name;

      const tyreWidth  = mesh.geometry.boundingBox.getSize(new THREE.Vector3()).z;
      wheels.push({
        pivot,
        mesh,
        tyreWidth,
        basePosx : pivot.position.x,   // remember once
        front     : spec.front
      });

    });

    // store for your animation loop
    carModel.userData.wheelPivots = wheels;

    // optional: add helpers to debug:
    // wheels.forEach(w => w.pivot.add(new THREE.AxesHelper(0.2)));
    /* ─ Stash everything the other modules need ─────────────────────── */
// 1) Grab the four wheel entries by front/side:
    const wheelFL = wheels.find(w => w.mesh.name === 'tyre_FL');
    const wheelFR = wheels.find(w => w.mesh.name === 'tyre_FR');
    const wheelRL = wheels.find(w => w.mesh.name === 'tyre_RL');
    const wheelRR = wheels.find(w => w.mesh.name === 'tyre_RR');

    if (!wheelFL || !wheelFR || !wheelRL || !wheelRR) {
      console.error('Couldn’t find all 4 wheels!', wheels.map(w=>w.mesh.name));
    } 

    // 2) Compute wheelRadius from the mesh’s boundingSphere (in world units)
    wheelFL.mesh.geometry.computeBoundingBox();
    const wheelRadius = 0.5 *
    wheelFL.mesh.geometry.boundingBox.getSize(new THREE.Vector3()).y *
    carModel.scale.x;        // true hub → ground distance

    // 3) Wheelbase = distance along Z between front‐left and rear‐left pivots
    const wheelBase  = Math.abs(wheelFL.pivot.position.z - wheelRL.pivot.position.z);

    // 4) Track width = X distance between FL and FR pivots
    const trackWidth = Math.abs(wheelFL.pivot.position.x - wheelFR.pivot.position.x);

    // 5) boundingRadius (FL↔FR distance)
    const boundingRadius = trackWidth;

    // 6) noseOffset = how far the front axle is back from the nose of the car
    const noseOffset = bb.max.z - wheelFL.pivot.position.z;

    // 7) slideTimer initial value
    const slideTimer = 0;

    const wheelOnTrack = [true, true, true, true]; 

    // 8) Now stash exactly the same shape you used before:
    carModel.userData = {
      wheels,          // array of { pivot, front }
      wheelRadius,     // metres in world units
      wheelBase,       // FL ↔ RL distance
      trackWidth,      // left‐to‐right on front axle
      boundingRadius,  // same as trackWidth
      noseOffset,      // front axle ↔ car nose
      wheelFL,
      wheelFR,
      wheelRL,
      wheelRR,
      slideTimer,
      wheelOnTrack
    };
  carModel.traverse(obj=>{
    if (obj.isMesh){
      obj.castShadow    = true;   // make this mesh paint into the shadow-map
      obj.receiveShadow = false;  // usually off for bodywork
    }
});
    }, undefined, err => console.error('Error loading car model:', err));
}
  
function setupInput() {
  window.addEventListener('keydown', e => {
    if (driveKeys[e.code] !== undefined) driveKeys[e.code] = 1;
  });
  window.addEventListener('keyup', e => {
    if (driveKeys[e.code] !== undefined) driveKeys[e.code] = 0;
  });
}

       // start “legal”
const downRay_1  = new THREE.Raycaster();
const DOWN     = new THREE.Vector3(0, -1, 0);
const tmp      = new THREE.Vector3(0,0,0);


function updateWheelContacts(car){
  if (!trackRoad) return;               // guard if mesh not found
  const { wheelFL, wheelFR, wheelRL, wheelRR, wheelOnTrack } = car.userData;
  const wheels_1 = [wheelFL, wheelFR, wheelRL, wheelRR];

  for (let i = 0; i < 4; i++){
    // 1) hub world-space position
    const hub = pivotWorldPos(wheels_1[i]);        // ← changed line

    // 2) start the ray a hair above the tyre
    tmp.copy(hub).addScaledVector(DOWN,-0.2);
    downRay_1.set(tmp, DOWN);                      // DOWN = (0,-1,0)

    const hit = downRay_1.intersectObject(trackRoad, true)[0];
    wheelOnTrack[i] = !!hit;
  }
}

function updateLapTimer(dt){
  if (!carModel) return;                        // car not loaded yet

  /* 1 – current side of the start/finish plane */
  const side = Math.sign(
    carModel.position.clone().sub(startPos).dot(startNormal)
  );

  /* 2 – detect a crossing  (+1 ↔ –1, ignore 0) */
  if (prevSide !== 0 && side !== prevSide && carModel.position.z >0){
    const now = performance.now();
    /* 2A – first-ever crossing → start the chronometer */
    if (!lapActive){
      lapActive  = true;
      lapStartT  = now;
    }
    /* 2B – normal crossing → close the lap, test record, reset clock */
    else{
      const lapT = now - lapStartT;
      lapStartT  = now;                         // start new lap timer

      /* record check & HUD flash */
      const improved = (bestLapT === null || lapT < bestLapT);
      if (improved){
        bestLapT = lapT;
        hudLapBest.textContent  = 'Best ' + millisToClock(bestLapT);
      }
      hudLapCur.classList.add(improved ? 'flashGood' : 'flashBad');
      lapFlashTimer = 3.0;                      // 3 s colour window
    }
  }
  prevSide = side;   // remember for next frame

  /* 3 – decay the green/red flash colour */
  if (lapFlashTimer > 0){
    lapFlashTimer -= dt;
    if (lapFlashTimer <= 0){
      hudLapCur.classList.remove('flashGood', 'flashBad');
    }
  }
  
  /* 4 – live chronometer (runs every frame once lapActive) */
  if (lapActive){
    const curMs = performance.now() - lapStartT;
    hudLapCur.textContent = 'Lap  ' + millisToClock(curMs);
  }
}



function animateWheels(car, dt) {
  if (!car || !car.userData) return;
  
  const { wheels, wheelRadius, wheelBase, trackWidth } = car.userData;
  const steer  = physicsState.steerAngle;
  const spinΔ  = (physicsState.velocity / wheelRadius) * dt;   // radians this frame

  wheels.forEach(w => {
  if (w.front) {
    const sign   = Math.sign(steer) ;

    const scrub = 0.55 * w.tyreWidth * Math.sin(steer)* sign;
    w.pivot.rotation.y = steer;           // steer around **Y**
    w.pivot.position.x = w.basePosx + scrub*sign;
  //Scrub-radius translation: move the hub a little *in the same lateral direction* it is yawing.  Amount ≈ half the tyre width multiplied by sin(turnAngle).  Sign is left (–) / right (+).
  }
  /* rolling spin – keeps hub height constant */
  });
}

const _scratch = new THREE.Vector3();          // reuse every frame

const PAD_FRONT = 0.12, PAD_SIDE = 0.5, PAD_REAR = 0.01;


const _nMatrix   = new THREE.Matrix3();

/* ─── Detached debris & spark helpers ───────────────────────────── */
const debris     = [];          // { mesh, vel }
let gameOver = false;                       // becomes true on first fatal hit
const FLAP_LENGTH = 2.0;                    // metres that the nose sticks out

/* ─────────────────────────────────────────────────────────────────────
   Helper – detach the front flap at an explicit world‑space position.
   Keeps original orientation, adds slight hop so gravity settles it.
   ─────────────────────────────────────────────────────────────────── */
function detachFlapAt(car, dropPos){
  const flapSrc = car.getObjectByName('front_flap');
  if (!flapSrc || car.userData.flapDetached) return;

  flapSrc.visible = false;
  const flap = flapSrc.clone();
  flap.position.copy(dropPos);
  flap.quaternion.copy(flapSrc.getWorldQuaternion(new THREE.Quaternion()));
  scene.attach(flap);
  flap.visible = true;  
  flap.castShadow = true;

  // simple upward hop
  const initialVel = new THREE.Vector3(0, 0.4, 0);
  debris.push({ mesh: flap, vel: initialVel });
  car.userData.flapDetached = true;
}

function endRace(){
  if (gameOver){
    const overlay = document.getElementById('raceOverlay');
    overlay.innerHTML =
    '<h1>Game Over</h1>' +
    '<p>You go out of the track</p>';
    overlay.classList.add('show');
    return;
  }
  gameOver = true;
  // freeze input & physics
  driveKeys.KeyW = driveKeys.KeyS = driveKeys.KeyA = driveKeys.KeyD = 0;
  physicsState.velocity   = 0;
  physicsState.steerAngle = 0;

  // assume <div id="raceOverlay"></div> in index.html and CSS defined
  const overlay = document.getElementById('raceOverlay');
  overlay.innerHTML =
    '<h1>Game Over</h1>' +
    '<p>You have hit the wall</p>';
  overlay.classList.add('show');
}


/* util: safe integer clamp -------------------------------------------------- */
function intClamp(val, min, max) {
  return Math.max(min, Math.min(max, Math.floor(val)));
}

/* call: spawnSparks(hitPoint, wallNormal, speedIn) */
function spawnSparks(hitPt, normal, speedIn = 0) {

  /* --- 1) pick a solid integer COUNT -------------------------------------- */
  const COUNT = intClamp(10 + speedIn * 2, 8, 60);

  /* --- 2) allocate matching sized buffers --------------------------------- */
  const posArray = new Float32Array(COUNT * 3);   // xyz per spark
  const velArray = new Float32Array(COUNT * 3);   // velocities

  /* --- 3) fill them -------------------------------------------------------- */
  const sideAxis = normal.clone().cross(AXIS_Y).normalize();
  for (let i = 0; i < COUNT; i++) {

    /* every spark starts exactly at the impact point */
    posArray[i*3+0] = hitPt.x;
    posArray[i*3+1] = hitPt.y;
    posArray[i*3+2] = hitPt.z;

    /* mostly slide along wall, bias a bit forward + random spread */
    const dir = sideAxis.clone()
        .applyAxisAngle(normal, THREE.MathUtils.randFloatSpread(Math.PI * 0.7))
        .addScaledVector(normal, THREE.MathUtils.randFloat(-0.25, 0.05))
        .normalize()
        .multiplyScalar(3 + Math.random() * 2);

    velArray[i*3+0] = dir.x;
    velArray[i*3+1] = Math.abs(dir.y) * 0.4;       // slight upward kick
    velArray[i*3+2] = dir.z;
  }

  /* --- 4) build geometry & material (NO texture) -------------------------- */
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geo.setAttribute('velocity', new THREE.BufferAttribute(velArray, 3));

  const mat = new THREE.PointsMaterial({
    color: 0xffb050,
    size: 0.1,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.9,
    depthWrite: false            // avoid spark-self-shadow artifacts
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;     // skip bounding-sphere calc → no NaNs
  pts.userData.life = 0.25 + speedIn * 0.02;
  scene.add(pts);

  debris.push({ mesh: pts });    // same debris array you already use
}


function updateDebris(dt) {
  for (let i = debris.length-1; i >= 0; i--) {
    const d = debris[i];
    if(d.mesh.isPoints){
      d.mesh.userData.life -= dt;
      if (d.mesh.userData.life <= 0) {
        scene.remove(d.mesh);
        debris.splice(i, 1);
        continue;
      }
      const pos=d.mesh.geometry.attributes.position;
      const vel=d.mesh.geometry.attributes.velocity;
      for(let p=0;p<pos.count;p++){
        vel.array[p*3+1]-=9.8*dt*0.4;            // gravity on y-vel
        pos.array[p*3+0]+=vel.array[p*3+0]*dt;
        pos.array[p*3+1]+=vel.array[p*3+1]*dt;
        pos.array[p*3+2]+=vel.array[p*3+2]*dt;
      }
      pos.needsUpdate=true;
    } else {                                    // flap debris
      d.mesh.position.addScaledVector(d.vel, dt);
      d.vel.y -= 9.8 * dt;                      // gravity
      if (d.mesh.position.y < trackModel.position.y + 0.05) {
        d.vel.set(0,0,0);                       // rest on the floor
      }
    }
  }
}


const RESTITUTION        = 0.60;   // 0 = dead stop, 1 = elastic
const MAX_REBOUND_SPEED  = 22;     // m/s cap
const SAFE_OFFSET        = 0.05;   // push chassis 5 cm clear
const EXIT_CLEARANCE     = 0.06;   // how far to move away before the
const WALL_IGNORE_DURATION = 0.3;   // seconds to ignore collisions after each hit


// -----------------------------------------------------------------------
//  Called exactly once at the first terminal impact.
//  Freezes input, zeroes physics and shows an overlay (optional).
// -----------------------------------------------------------------------
// in your physicsState (initially)
physicsState.lastHitTime = -Infinity;

function pivotWorldPos(wheel) {
  return wheel.pivot.position.clone()
    .applyQuaternion(carModel.quaternion)
    .add(carModel.position);
}

function handleWallCollision(car, dt){
  if (gameOver) return;
  if (physicsState.velocity < -0.01) physicsState.lastWallNormal = null;
  if (physicsState.lastWallNormal && physicsState.velocity > 0) physicsState.lastWallNormal = null;
  const fwd = new THREE.Vector3(0,0,1).applyQuaternion(car.quaternion);
  const velWorld = fwd.clone().multiplyScalar(physicsState.velocity);
  if (physicsState.lastWallNormal){
    const vDotN = velWorld.dot(physicsState.lastWallNormal);
    const signedDist = physicsState.lastWallNormal.dot(car.position) - physicsState.lastWallOffset;
    if (vDotN > 0.01 && signedDist < EXIT_CLEARANCE) return;
    physicsState.lastWallNormal = null;
  }

  // Trace wheels
  const { wheelFL, wheelFR, wheelRL, wheelRR, wheelRadius } = car.userData;
  const left = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), fwd);
  const back = fwd.clone().negate();
  const wheels = [
    { pos: pivotWorldPos(wheelFL), dir: fwd, pad: PAD_FRONT },
    { pos: pivotWorldPos(wheelFR), dir: fwd, pad: PAD_FRONT },
    { pos: pivotWorldPos(wheelFL), dir: left, pad: PAD_SIDE },
    { pos: pivotWorldPos(wheelRL), dir: left, pad: PAD_SIDE },
    { pos: pivotWorldPos(wheelRL), dir: back, pad: PAD_REAR },
    { pos: pivotWorldPos(wheelRR), dir: back, pad: PAD_REAR }
  ];

  for (const w of wheels){
    if (velWorld.dot(w.dir) <= 0) continue;
    tyreRaycaster.ray.origin.copy(w.pos);
    tyreRaycaster.ray.direction.copy(w.dir);
    tyreRaycaster.far = wheelRadius + w.pad;
    const hit = tyreRaycaster.intersectObjects(wallMeshes,false,_hits);
    if (!hit.length) continue;
    _nMatrix.getNormalMatrix(hit[0].object.matrixWorld);
    const triN = hit[0].face.normal.clone().applyMatrix3(_nMatrix).setY(0).normalize();
    if (triN.lengthSq()===0) triN.copy(w.dir).negate();
    if (velWorld.dot(triN)>=0) continue;

    // resolve penetration
    const penetration = tyreRaycaster.far - hit[0].distance + SAFE_OFFSET;
    car.position.addScaledVector(triN, penetration);
    const hitPt = hit[0].point.clone();
    const normal = triN.clone();
    const contactPos = hitPt.clone().addScaledVector(normal, WALL_EPS).addScaledVector(normal, FLAP_LENGTH - 1.5);
    car.position.copy(contactPos);
    
    
    // compute lateral offset in spawn position
    const up = new THREE.Vector3(0,1,0);
    const right = fwd.clone().cross(up).normalize();
    const lateralSign = velWorld.dot(right)>=0 ? 1 : -1;
    const lateralOffset = right.clone().multiplyScalar(0.6 * lateralSign);
    const groundY = trackModel ? trackModel.position.y + 0.025 : hitPt.y;
    // ── robust ground snap: step 10 cm into the track then ray‑cast down
    const flapDrop = hitPt.clone().addScaledVector(normal,FLAP_LENGTH)
    //flapDrop.y = carModel.position.y +0.5;

    // Height difference between chassis pivot (car.position.y) and ground when wheels touch
    const CHASSIS_PIVOT_TO_GROUND = 0.42; // metres – adjust once for your model
    // drop flap and retreat
    if (!car.userData.flapDetached){
       detachFlapAt(car, flapDrop);
       playCollision();}
    car.position.addScaledVector(normal, FLAP_LENGTH);

    // stop physics & FX
    physicsState.velocity=0; physicsState.steerAngle=0;
    spawnSparks(hitPt,normal,Math.abs(physicsState.velocity));
    physicsState.lastWallNormal=normal.clone();
    physicsState.lastWallOffset=normal.dot(hitPt);
    physicsState.lastHitTime=performance.now()*0.001;

    endRace();
    return;
  }
}

// -----------------------------------------------------------------------
//  REPLACEMENT: animate()
//  Skips physics once the race has ended but keeps visuals alive
// -----------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (carModel && trackRoad) {
    updateLapTimer(dt);
    if (!gameOver) {
      applyCarPhysics(carModel, driveKeys, dt, physicsState, physicsConfig);
      updateGroundSnapping();
      updateWheelContacts(carModel);
      updateAudio(physicsState.gear, physicsState.rpm, physicsState.velocity, driveKeys.KeyW);
      
      hudGear.textContent = `Gear: ${physicsState.gear + 1}`;
      hudGear.dataset.gear = physicsState.gear + 1;   // for CSS colour-coding

      const rpmPercent = Math.round(physicsState.rpm * 100);
      hudRPM.textContent = `RPM : ${rpmPercent}%`;

      const kmh = (physicsState.velocity * 3.6).toFixed(0); // m/s ➜ km/h
      hudSpeed.textContent = `Speed: ${kmh} km/h`;

      // Progress-bar width via a CSS custom property
      hudRPM.style.setProperty('--rpm-bar', `${rpmPercent}%`);
      handleWallCollision(carModel, dt);
      animateWheels(carModel, dt);
      for (let i=0; i < 4; i++){
        if (carModel.userData.wheelOnTrack[i]){
          gameOver = false;
          break;}
        gameOver = true;
      }
    }else{
      hudSpeed.textContent = 'Speed : 0 km/h';
      updateAudio(physicsState.gear, physicsState.rpm, physicsState.velocity, driveKeys.KeyW);
      endRace();
    }

    updateDebris(dt);            // always run so sparks & flap animate
    const hub = pivotWorldPos(carModel.userData.wheelFL);
    const dir = DOWN.clone();
    tmp.copy(hub).addScaledVector(dir, 0.2);
    downRay.set(tmp, dir);
    const hits = downRay.intersectObject(trackRoad, true);
    
  }

  updateSunShadow();
  updateCamera();
  renderer.render(scene, camera);
}


// Re-use scratch vectors so we don't GC every frame
const TMP  = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const ray    = new THREE.Raycaster();

function updateGroundSnapping() {
  if (!carModel || !trackModel) return;   // trackRoad not needed here

  const { wheelFL, wheelFR, wheelRL, wheelRR, wheelRadius } = carModel.userData;
  const wheels = [wheelFL, wheelFR, wheelRL, wheelRR];
  const hits   = [];

  // ── 1) one ray per wheel ───────────────────────────────────────────────
  for (let w of wheels) {
    // start ray a bit above the hub to avoid hitting inside geometry
    const hub = w.pivot.getWorldPosition(TMP);
    TMP2.set(hub.x, hub.y + wheelRadius + 1.0, hub.z);
    ray.set(TMP2, DOWN);

    const allHits = ray.intersectObject(trackModel, true);
    let goodHit   = null;

    // pick the first face whose normal points mostly up
    
    for (const h of allHits) {
      if ( !h.face ) continue;            // safety for non-tri meshes
      const worldN = h.face.normal.clone().transformDirection( h.object.matrixWorld );

      if ( worldN.dot( AXIS_Y ) > 0.6 ) { // upward-facing triangle?
        goodHit = h;
        break;
      }
    }
    if (!goodHit){
      return;}       // entire car is airborne – skip this frame

    hits.push(goodHit.point.clone());
  }

  // ── 2) fit ground plane ────────────────────────────────────────────────
  const ground = new THREE.Plane().setFromCoplanarPoints(
                  hits[0], hits[1], hits[2], hits[3]);            // FL, FR, RL, RR
  if (ground.normal.dot(AXIS_Y) < 0) ground.negate();
  // ── 3) orient chassis (keep yaw) ───────────────────────────────────────
  const up = ground.normal;
    // ── 3) orientation = tilt then yaw on the plane ───────────────────────
  const tiltQ = new THREE.Quaternion().setFromUnitVectors( AXIS_Y, up );
  const yawQ  = new THREE.Quaternion()                       // keep heading
                   .setFromAxisAngle( AXIS_Y, physicsState.yawAngle );
  carModel.quaternion.copy( yawQ ).premultiply( tiltQ );        // yaw → tilt

  // ── 4) translate chassis so lowest wheel just kisses the plane ─────────
  let deepestPen = Infinity;   // penetration < 0 means wheel under the plane
  wheels.forEach(w => {
    const hubWorld = w.pivot.getWorldPosition(TMP);
    const clearance  = ground.distanceToPoint(hubWorld);
    deepestPen = Math.min(deepestPen, clearance);
  });
  
  const REST_OFFSET = 0.12; 
  const dy = -deepestPen - REST_OFFSET;         // signed vertical delta
  carModel.position.y += dy;
}



function updateCamera() {
  if (!carModel) return;
  const worldCamOffset = localCamOffset.clone().applyQuaternion(carModel.quaternion);
  camera.position.copy(carModel.position).add(worldCamOffset);
  camera.lookAt(carModel.position);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
