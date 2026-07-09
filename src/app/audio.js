// Procedural sound — pure Web Audio, zero assets, a few oscillators with
// ADSR envelopes. Presentation only: it reads sim EVENTS, never state.
//
// Unlike Wrong Sky, this city has no "restore sound" fiction — it's already a
// living place (guards, cars, footsteps), so there's no mute/unmute story
// beat. The one real constraint is the browser autoplay gate: an
// AudioContext must be created inside a genuine user gesture or it boots
// suspended and never resumes. So prime() — which both creates the context
// AND brings it to full volume in one step — is called on the player's very
// first real input (see game.js), never gesturelessly at boot.

export function makeAudio() {
  let ctx = null;
  let master = null;
  let primed = false;

  function prime() {
    if (primed) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
      primed = true;
    } catch { primed = false; }
  }

  function blip(freq, t0 = 0, type = 'square', dur = 0.12, slideTo = null) {
    if (!primed || !ctx) return;
    const start = ctx.currentTime + t0;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(1, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g); g.connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  function play(name) {
    if (!primed) return;
    switch (name) {
      case 'melee': blip(220, 0, 'square', 0.09, 140); break;
      case 'aura': blip(520, 0, 'sawtooth', 0.16, 180); break;
      case 'hit': blip(160, 0, 'triangle', 0.10); break;
      case 'no_effect': blip(120, 0, 'sine', 0.14, 90); break;
      case 'break': blip(90, 0, 'square', 0.14, 60); break;
      case 'pickup': blip(760, 0, 'triangle', 0.10, 990); break;
      case 'quest': blip(523, 0, 'triangle', 0.14, 659); break;
      case 'defeat': blip(300, 0, 'sawtooth', 0.28, 70); break;
      case 'boss': blip(70, 0, 'sawtooth', 0.5, 50); blip(140, 0.05, 'square', 0.4); break;
      case 'heal': blip(500, 0, 'sine', 0.2, 720); break;
      case 'hurt': blip(180, 0, 'sawtooth', 0.14, 110); break;
      case 'chapter': blip(392, 0, 'sine', 0.3, 523); blip(587, 0.15, 'triangle', 0.4); break;
      default: break;
    }
  }

  return { prime, play, get enabled() { return primed; } };
}
