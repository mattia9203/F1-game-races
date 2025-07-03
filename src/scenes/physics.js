
import * as THREE from 'three';

// ——— Vehicle & environment constants ————————————————
const MASS           = 795;        // kg (2025 F1 minimum)
const RHO_AIR        = 1.225;      // kg m⁻³
const FRONTAL_AREA   = 1.45;       // m²
const DRAG_COEFF     = 0.50;       // Cd – conservative (with wings)
const DOWNFORCE_C    = 3.5;        // Lift‑to‑drag‑ratio → downforce = C⋅ρ⋅A⋅v²
const MU_TIRE        = 1.8;        // base tire grip coefficient (slicks)
const G              = 9.81;

// ——— Gear ratios ————————————————————————————————
const GEAR_MAX = [
  20.5,   // Gear 1  = 50 km/h
  35.0,   // Gear 2  = 147 km/h
  52.0,   // Gear 3  = 187 km/h
  62.0,   // Gear 4  = 223 km/h
  71.5,   // Gear 5  = 257 km/h
  81.0,   // Gear 6  = 292 km/h
  90.0,   // Gear 7  = 324 km/h
  97.2    // Gear 8  = 350 km/h (max top speed)
];
const UP_RPM   = 0.92;
const DOWN_RPM = 0.25;
const GEARS    = GEAR_MAX.length;
const GEAR_MIN = [0].concat(GEAR_MAX.slice(0, -1));
const GEAR_TORQUE = [1.9, 1.65, 1.45, 1.3, 1.2, 1.1, 1.03, 1.0];


// ——— Steering lock limits ————————————————————————
const STEER_LOCK_LOW  = THREE.MathUtils.degToRad(30);
const STEER_LOCK_HIGH = THREE.MathUtils.degToRad(4);
let base;

function gearTorqueMult(g) {
  const base = 1.0 - g * 0.06;          // drops ~6% per gear
  return Math.max(base, 0.63);          // never go below 55%
}
// cached vecs
const fwdVec = new THREE.Vector3();

export function applyCarPhysics(car, keys, dt, state, cfg){
  // init / pull state———————————————————
  if (state.yawAngle === undefined)          // first frame after load/reset
    state.yawAngle = car.rotation.y;         // copy the model’s current yaw

  let v     = state.velocity ?? 0;   // m/s ( +fwd )
  let yaw   = state.yawAngle;
  let gear  = state.gear ?? 0;
  let rpm   = state.rpm  ?? 0;

  // 1. Engine thrust (simplified)
  const torqueMul = gearTorqueMult(gear);
  if(keys.KeyW){
    const P_MAX = 735500;  // watts
    const vEff  = Math.max(3, v);  // prevent infinite accel at standstill
    const a     = (P_MAX / vEff) / MASS;
    v += a * torqueMul * dt;
  }
  if(keys.KeyS) v -= cfg.brakeDecel * dt;

  // 2. Aerodynamic drag & rolling resistance
  const dragF = 0.5 * RHO_AIR * DRAG_COEFF * FRONTAL_AREA * v*v;
  const dragAcc = dragF / MASS;
  v -= Math.sign(v) * dragAcc * dt;

  // 2b. Simple engine braking when throttle is released
  if (!keys.KeyW) {
   // tweak this constant to taste (e.g. 5 m/s² gives a decent fall-off)
    const engineBrakeDecel = 5.0;
    v -= Math.sign(v) * engineBrakeDecel * dt;
  }


  // 3. Gearbox update——————————————————
  const vMin = gear===0?0:GEAR_MAX[gear-1];
  const vMax   = GEAR_MAX[gear];
  // 3. Gearbox update ———————————————————————————
  const range = GEAR_MAX[gear] - GEAR_MIN[gear];
  const rpmRaw = THREE.MathUtils.clamp((v - vMin) / (vMax - vMin), 0, 1); // 0-1
  rpm    = Math.pow(rpmRaw, 0.6);      // eased value for HUD & audio                                    // ease-out curve


  // up-shift if you hit red-line
  if (rpmRaw > UP_RPM && gear < GEARS - 1) {
    gear++;
    // reset rpm into the new gear’s range
    rpm = THREE.MathUtils.clamp((v - GEAR_MIN[gear])/(GEAR_MAX[gear] - GEAR_MIN[gear]), 0, 1)**0.6;
  }
  // down-shift only once you drop below the gear’s lower speed bound
  else if (v < vMin && gear > 0) {
    gear--;
    rpm = THREE.MathUtils.clamp((v - GEAR_MIN[gear])/(GEAR_MAX[gear] - GEAR_MIN[gear]), 0, 1)**0.6;
  }

  // 4. Steering input———————————————————
  let steer = 0;
  if(keys.KeyA && !keys.KeyD) steer =  STEER_LOCK_LOW;
  else if(keys.KeyD && !keys.KeyA) steer = -STEER_LOCK_LOW;

  const speedFactor = Math.min(Math.abs(v)/cfg.maxSpeed,1);
  const maxLock = THREE.MathUtils.lerp(STEER_LOCK_LOW, STEER_LOCK_HIGH, speedFactor);
  steer = THREE.MathUtils.clamp(steer,-maxLock,maxLock);

  // 5. Lateral grip limit———————————————————
  const wheelBase = car.userData.wheelBase || 2.6;
  let omegaDes = Math.abs(steer)>1e-4 ? v*Math.tan(steer)/wheelBase : 0;
  let aLatReq  = Math.abs(omegaDes)*Math.abs(v);

  // downforce increases grip quadratically with speed
  const downForce = 0.5 * RHO_AIR * DOWNFORCE_C * FRONTAL_AREA * v*v;
  const normalF   = MASS*G + downForce;
  const aLatMax   = MU_TIRE * normalF / MASS;

  if(aLatReq > aLatMax){
    // limit turn rate – results in under‑steer & forces braking ahead of corners
    const scale = aLatMax / aLatReq;
    omegaDes *= scale;   // reduced rotation rate
    aLatReq   = aLatMax; // (for completeness)
  }

  // 6. Apply rotation & advance—————————————————
  yaw += omegaDes * dt;
  state.yawAngle = yaw;
  car.rotation.y = yaw;

  fwdVec.set(0,0,1).applyAxisAngle(new THREE.Vector3(0,1,0), yaw);
  car.position.addScaledVector(fwdVec,v*dt);

  // persist state———————————————————————
  state.velocity = v;
  state.gear     = gear;
  state.steerAngle = steer
  state.rpm      = rpm;
  state.rpmRaw = rpmRaw;
}
