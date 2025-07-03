
import { launchGarage } from './scenes/GarageScene.js';
import { launchRace } from './scenes/RaceScene.js';

document.getElementById("customizeBtn").addEventListener("click", () => {
  document.getElementById("menu").style.display = "none";
  launchGarage();
});

document.getElementById("startRaceBtn").addEventListener("click", async () => {
  document.getElementById("menu").style.display = "none";
  launchRace();
});
