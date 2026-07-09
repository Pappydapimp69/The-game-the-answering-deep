// Boot shell. Everything here is presentation; the sim lives in src/sim and is
// only ever mutated through game.js's dispatch.
//
// Resolution: the canvas backing store tracks the viewport size (× a capped DPR
// for crispness), so the game fills the whole field of view at any monitor size
// without letterboxing. The renderer reads canvas.width/height every frame and
// scales the world + camera to fit; text is anchored in screen space with its
// own scale. Live resizes just work (each frame redraws from scratch).

import { runTitle } from './app/title.js';
import { startGame } from './app/game.js';

const canvas = document.getElementById('game');

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor((window.innerWidth || 640) * dpr));
  const h = Math.max(1, Math.floor((window.innerHeight || 360) * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ?seed=N for reproducible sessions (dev/testing only — the title screen owns
// the real new-game/continue flow players see).
const params = new URLSearchParams(location.search);
const seed = Number.parseInt(params.get('seed') ?? '', 10);
const bootSeed = Number.isInteger(seed) ? seed : 0xb17c5;

async function boot() {
  const choice = await runTitle(canvas);
  const game = choice.action === 'continue'
    ? startGame(canvas, bootSeed, {}, choice.world)
    : startGame(canvas, bootSeed, { archetype: choice.archetype, difficulty: choice.difficulty, saga: choice.saga || null });

  // Test hook — lets a headless harness read state and drive the same command
  // vocabulary as any input device. Read-only proxy: writes throw.
  window.__game = game;
}
boot();
