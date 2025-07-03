// AudioEngine.js

import * as THREE from 'three';

//
// ————————————————————————————————————————————————————————————————————————
// 1) Asset paths & config
// ————————————————————————————————————————————————————————————————————————
const AUDIO_PATHS = {
  idle:      '/assets/sounds/engine_idle.mp3',
  high:      '/assets/sounds/engine_high.mp3',
  off:       '/assets/sounds/engine_offthrottle.mp3',
  collision: '/assets/sounds/collision_metal.mp3'
};

const CFG = {
  volume:   { idle: 0.3, high: 0.5, off: 0.2 },
  rampVol:  0.1,
  rampRate: 0.1,
  minVel:   0.1,
  upRpm:    0.9,
  rate: {
    // gentler idle wobble
    idle: (rpm, gear) => 0.4 + rpm * 0.15,
    // much less jump in 1st/2nd—gear’s influence is only half as strong,
    // and RPM-driven pitch only +0.3 at full throttle
    high: (rpm, gear) => 0.8 + gear * 0.05 + rpm * 0.3
  }
};

//
// ————————————————————————————————————————————————————————————————————————
// 2) Module‐scope state
// ————————————————————————————————————————————————————————————————————————
let listener        = null;    // THREE.AudioListener
let ctx             = null;    // AudioContext
let beds            = {};      // { idle, high, off } → THREE.Audio or dummy
let collisionBuffer = null;    // AudioBuffer
let lastGear = null;
//
// ————————————————————————————————————————————————————————————————————————
// 3) setupAudio(camera): call this first!
//    - creates & attaches the listener
//    - then loads all sounds
// ————————————————————————————————————————————————————————————————————————
export function initAudio(camera) {
  if (!camera || !camera.add) {
    console.warn('AudioEngine.setupAudio: please pass your THREE.Camera');
    return;
  }

  // 1) create & attach listener
  listener = new THREE.AudioListener();
  camera.add(listener);
  ctx = listener.context;
  lastGear = null;

  // 2) load all buffers now that listener & ctx exist
  const loader = new THREE.AudioLoader();

  const loadBed = (key) => {
    loader.load(AUDIO_PATHS[key], buffer => {
      beds[key] = makeLoop(buffer, CFG.volume[key]);
    });
  };

  ['idle', 'high', 'off'].forEach(loadBed);
  loader.load(AUDIO_PATHS.collision, buf => { collisionBuffer = buf; });
}

//
// ————————————————————————————————————————————————————————————————————————
// 4) makeLoop(): if listener isn’t set up yet, return a dummy no-op
// ————————————————————————————————————————————————————————————————————————
function makeLoop(buffer, vol) {
  if (!listener) {
    // return a stub that won’t crash in updateAudio
    return {
      isPlaying: false,
      setVolume() {},
      setPlaybackRate() {}
    };
  }
  const audio = new THREE.Audio(listener);
  audio.setBuffer(buffer);
  audio.setLoop(true);
  audio.setVolume(0);
  audio.play();
  return audio;
}

//
// ————————————————————————————————————————————————————————————————————————
// 5) updateAudio(): safe to call every frame, even before setupAudio
// ————————————————————————————————————————————————————————————————————————
export function updateAudio(gear, rpmRaw, velocity, throttleHeld) {
  // if we haven’t got a listener yet, or we’ve suspended after crash, bail
  if (!listener || ctx?.state === 'suspended') return;

  if (lastGear === null) lastGear = gear;

 // detect down-shift
  if (gear < lastGear) {
    const offBed = beds.off;
    if (offBed) {
      // stop & replay to “restart” the loop at gear change
      offBed.stop();
      offBed.play();
   }
 }
 lastGear = gear;


  // parked & throttle off → silence all
  if (velocity < CFG.minVel && !throttleHeld) {
    Object.values(beds).forEach(b => b.setVolume(0));
    return;
  }

  // cross-fade idle ↔ high ↔ off
  const rpmNorm = THREE.MathUtils.clamp(rpmRaw / CFG.upRpm, 0, 1);
  const volHigh = rpmNorm;
  const volIdle = 1 - rpmNorm;
  const volOff  = (!throttleHeld && velocity > CFG.minVel) ? rpmNorm : 0;

  [
    ['idle', volIdle, CFG.rate.idle(rpmNorm, gear)],
    ['high', volHigh, CFG.rate.high(rpmNorm, gear)],
    ['off',  volOff,  CFG.rate.high(rpmNorm, gear)]
  ].forEach(([key, tVol, tRate]) => {
    const a = beds[key];
    if (!a || !a.isPlaying) return;
    a.setVolume( THREE.MathUtils.lerp(a.getVolume(),      tVol,  CFG.rampVol) );
    a.setPlaybackRate( THREE.MathUtils.lerp(a.playbackRate, tRate, CFG.rampRate) );
  });
}

//
// ————————————————————————————————————————————————————————————————————————
// 6) playCollision(): play once, then suspend the AudioContext
// ————————————————————————————————————————————————————————————————————————
export function playCollision() {
  if (!listener || !collisionBuffer) return;

  const sfx = new THREE.Audio(listener);
  sfx.setBuffer(collisionBuffer);
  sfx.setLoop(false);
  sfx.setVolume(1.0);
  sfx.play();

  sfx.onEnded = () => {
    ctx?.suspend().catch(err => console.warn('Audio suspend failed:', err));
  };
}