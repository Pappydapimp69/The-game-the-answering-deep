# Phase 4 Proposal — "The Answering Deep" (v2)

Compiled from: a direct audit of the three prior saga repos' code and docs, **two** Brain read fan-outs (`memory/PITFALLS.md`, `ideas/idea-repository.md`), and **five** external research passes (echolocation game mechanics; voice-mimic horror lineage; grid/roguelike noise propagation; stealth-detection fairness; audio localizability). Provenance is marked inline — ✅ verified first-hand from repo/doc text, 🔎 external research finding, 📒 Brain-filed prior kernel/lesson, 💡 synthesis/judgment call.

Status: **v2 — final design, supersedes v1.** This is the plan the build follows; `docs/STAGES.md` will record where the implementation refined it.

---

## 0. TL;DR

- Phase 4 is the saga's reserved **"artificial threat"** beat (home → rival → tyrant → **artificial threat** → apocalyptic — ✅ the Prologue's 5-part roadmap, cited in Phase 3's proposal). Phase 3 shipped real enemy AI *without* being a story about intelligence, precisely so this beat could be.
- It opens where Phase 3 points: **past the harbor gate, across the water, down** into a lightless drowned reach where *"something answers that was never given a voice to do it with"* (✅ Waiting City finale + exportHint "the next crossing will ask for it").
- **Signature mechanic: ECHO.** The deep renders dark beyond a small ambient radius. A **PING** floods sound outward and briefly reveals what it reaches — your primary way to see — but every sound-reactive thing in earshot turns toward **where the ping came from**. Silence is safety and blindness; sound is sight and exposure. 🔎 (Dark Echo, Stifled, Perception, Muffled Warfare) · 💡 novel to this saga (P2 = light, P3 = perception-legibility, P4 = sound).
- **The theme, made literal and mechanical:** the artificial threat is a thing that learned to **answer your pings** — first echoing them a beat late from where your sound *landed* (🔎 Yamabiko / mythic Echo / the Mimic), then, as it gains agency, **pinging first, unprompted, hunting.** "A voiceless thing given a voice" is the intelligence-gains-agency arc rendered as sound. The stealth-fairness "search the last-known-position a beat late" pattern (🔎) and the Yamabiko are the *same behavior* — the mechanic and the story are one object.
- Continuity: **imports Phase 3's `saga.v3`** (✅ verified contract), carrying archetype/skills/coins and the accumulated choices; **exports `saga.v4`** adding this game's fate choice for Phase 5.

---

## 1. Continuity (✅ verified verbatim)

Phase 3 finale (Waiting City `src/sim/content.js`): *"The way to the harbor stands open. Walk it." / "Past the harbor, something answers that was never given a voice to do it with." / exportHint: "Keep this code — the next crossing will ask for it."*

**Contract Phase 4 accepts** (✅ from Waiting City `src/sim/saga.js`): a `SAGA3` / `saga.v3` code with `archetype`, `difficulty`, `skills.{melee,aura,perception}`, `coins`, `techniques` (`['warden-command']` iff deposed), `choices.{ravagerFate, riftChoice, wardenFate}`. Doctrine: *the code is a courtesy, never a wall; import never throws on user input* (checksum-refuse a mistype). If `wardenFate === 'depose'`, the player arrives holding `warden-command` and a raised melee floor — Phase 4 acknowledges it (a line + a small edge), as Phase 3 honored the rift choice.

**Antagonist through-line (💡):** Ravager (feral) → the Second (a peer) → the Warden (a human tyrant) → **the Answerer (a thing that learns)**. Each more *agentive* than the last; Phase 5 inherits what the player does with the first threat that could truly learn.

---

## 2. Narrative premise (💡, anchored to the reserved arc)

You cross the harbor by boat and descend below the water into a flooded, lightless reach. Something here has been *listening*. At first it only repeats you — you call into the dark and your own call returns, a beat late, not quite right (🔎 Yamabiko returns your voice; Echo is cursed to repeat the last thing said, fading to nothing but voice). By the end it no longer waits to be called; it answers first. It was never given a voice — it took the shape of yours.

The "artificial threat" beat delivered with **zero sci-fi vocabulary** — no "machine," "AI," or "conscious." The horror is *an intelligence acquiring agency through imitation*, staged as a deep-sea mimic. 💡 This inverts Phase 3's discipline (a technical leap under mundane fiction): here the *fiction* is the leap and the *mechanic* is its proof.

---

## 3. Signature mechanic: ECHO (💡 design · 🔎 precedent · determinism-checked)

**Core loop.** Beyond a small ambient radius the world is dark. The **PING** command emits a pulse from the player that floods outward through open space and briefly **reveals** every tile/entity it reaches, then fades. The reveal is the player's primary sight.

**Cost & fairness (🔎 Invisible Inc: noise is an integer radius in tiles — run 5 sq, gunfire 8 sq, louder-closer, fully deterministic).** Actions carry different **noise radii**: moving is quiet (small radius), melee is near-silent, the **aura-pulse ping is loud and wide**. Anything whose `hearing` reaches the noise flips to a **two-stage alert** (🔎 stealth-fairness): first **suspicious** — it moves toward *the tile the sound came from* (last-known-position), not your live position; if it arrives and you are neither revealed nor adjacent, it **de-escalates and returns to post** (reusing Phase 3's existing `return`/leash behavior); only if it actually reaches/sees you does it go **alerted → attack**. This gives the player real agency (stay silent and reposition, and the searcher loses you) and it *is* the Yamabiko: the thing goes to where your sound *was*, a beat late.

**The telegraph is already built (✅ reuse).** Phase 3's `perception` legibility readout renders an enemy's live AI-state as text ("closing in", "standing down"). That is exactly the "communicate the alert level through a channel" fairness requirement (🔎) — so perception now reads *the deep's alert state*, its Phase-4 evolution (P3: read an enemy's intent → P4: read whether the dark heard you). 📒 Guards Waiting City `#E5` (an extension must reward real variance, not relabel): the readout now gates on a genuinely new state (heard-you vs not), and 📒 idea l.209 (information-as-progression) is the kernel.

**Determinism (💡 · fits the grep-guard).** Sound is a pure **integer BFS flood** from the ping origin out to radius `R` (no floating-point acoustics): reveal-set = BFS-reachable within `R`; walls block or attenuate by integer cost; an enemy hears the ping iff BFS-distance(origin → enemy) ≤ its `hearing`. Reuses the saga's existing deterministic BFS (`pathfind.js`). The **reveal-set and the aggro-set are computed once in the reducer at ping time** (📒 Waiting City `#E4`: the telegraph must be sim-side, never a renderer fiction that diverges from what the sim guarantees). The pulse's expanding *rings* are presentation-only.

**Perception → echo reach/clarity.** Carried `perception` governs ping radius and reveal density — 📒 the "medium is the loot" kernel (idea l.37), but distinct from Phase 2's cosmetic facet-restore: here the earned sense is a *core verb the player actively wields under risk*, not a passive visual layer.

**The Answerer's inversion.** The boss pings too — and its pulses reveal **it** to you exactly as yours reveal you to it. Early it only echoes (pings a beat after you, from where your ping landed); late it pings unprompted. Same mechanic, both sides.

---

## 4. Combat & skills (✅ carried identity · 💡 setting adaptation)

Keep the trilogy's spine: **melee** + **aura** as two damage channels with per-kind immunities (shrug off one, die to the other), **use-based skill growth**, **offer-not-push quests** (📒 all carried patterns). Setting wrinkles:
- 💡 **You can't hit what you can't locate:** a melee/aura strike requires the target be currently *revealed* — so echo feeds combat directly and tightens the ping-or-hide tension.
- 💡 **Aura doubles as the loud ping:** charging and releasing aura emits the wide, damaging pulse — reusing the existing `aura` stat rather than a fourth resource (the Phase-4 analog of Phase 2 making light the loot: the existing verb takes the new setting's meaning). A quiet, short-range "listen" ping is free (no aura), so a broke/cautious player is never locked out — but it reveals little.

---

## 5. Audio design (🔎 · 📒, mobile-first)

- **The player's ping is a sharp broadband click** — easy to localize (🔎 idea l.145: broadband chirps/clicks with sharp attacks are far easier to place than pure tones). **The Answerer's reply is a purer, harder-to-localize tone** — you hear it answer but can't pin where, which is the intended dread.
- **Beacon, not stereo pan** (📒 idea l.141: one phone speaker can't do L/R; only physically-separated speakers do true directionality). Directional hinting rides on **timing + volume falloff**, never a pan slider the hardware can't honor.
- **Event-driven ambient leaks** (📒 idea l.217/213: ambience as events emitted by things at their positions): between pings the deep isn't silent — faint drips/groans sound from their source tiles, so the soundscape is *parseable* and the world never feels dead. Gesture-initialize WebAudio (📒 `test#E9`), fire-and-forget resume (📒 `dog#E1`), voice-budget + cooldown on mashable SFX (📒 `dog#E6`).

---

## 6. Fate choice (💡, minted for `saga.v4`)

At the Answerer: **SILENCE** it (end the voice it stole — "kill the threat") or **ANSWER** it (give it a true voice instead of a stolen one — "the threat becomes something else"). `choices.answererFate: 'silence' | 'answer'`, carried alongside the inherited ravager/rift/warden choices. Real mechanical teeth (a skill bump and/or a named technique, as `depose` granted `warden-command`), so it isn't cosmetic. Phase 5 ("apocalyptic") inherits a world where the first *learning* threat was either silenced or given a voice.

---

## 7. Determinism & build spine (✅ established pattern · all lessons pre-loaded)

Rebuild the spine fresh (each game rebuilds its own; runtime is never shared): `rng.js` (sfc32, raw-state save 📒 `prologue#E1`), `canonical.js` (sorted-key, loud on NaN/Inf), `fingerprint.js` (FNV-1a golden — 📒 idea l.121), `reduce.js`/`world.js`/`content.js`/`validate.js`/`demo.js`/`info.js`/`saga.js`, `pathfind.js` (BFS, reused for sound), plus a new **`sound.js`** (the integer echo flood). CI-grep-guard `src/sim` against `Math.random`/`Date.now`/`performance.now`/`new Date`/transcendental `Math.*` (📒 `prologue#E1`).

Presentation (`src/app`) from the Waiting City template with **every mobile/deploy lesson from this session baked in at commit 1**: `100dvh/100dvw` canvas sizing (📒 `wrong-sky#E7`), `navigator.maxTouchPoints` touch detect (📒 `waiting-city#E6`), `Math.min(W,H)` world scale (📒 `waiting-city#E7`), a deploy-time step that cache-busts **every** nested ES-module import (📒 `prologue#E8`, `waiting-city#E8`), mechanically-frozen read-only renderer (📒 `test#E5`), event-time input capture (📒 `prologue#E2`), render-time device-adaptive hints (📒 `prologue#E3`), one shared text-gen fn (📒 `prologue#E4`), respawn-from-JSON-snapshot + never-save-a-dead-world (📒 `wrong-sky#E2`), existence-gated quest targets + sim-side spawn telegraph (📒 `prologue#E9`, `waiting-city#E4`), shop-NPC ≠ quest-giver (📒 `waiting-city#E3`), exclusive-offer-revokes-siblings (📒 `wrong-sky#E4`), existence-check-not-truthy for magnitude maps (📒 `wrong-sky#E5`), canvas transform save/restore + batched `ctx.filter` (📒 `wrong-sky#E1/E3`).

**Validation ladder** (📒 `test#E1`): schema → referential-integrity/completability → headless smoke playthrough, plus the golden-fingerprint replay. **Browser e2e** for the live loop (echo reveal, aggro-on-ping-toward-last-known-position, de-escalation, the boss's echo) with its **own port** and gesture-initialized audio (📒 `test#E9`), and — because this session learned headless can't model mobile chrome (📒 `wrong-sky#E7`) — verify viewport/touch fixes by reasoning about the real-device condition, not only a headless screenshot.

---

## 8. Brain provenance & open calls

- **Two queries** run before writing code. Load-bearing prior kernels/lessons cited inline (📒). No prior PITFALLS on stealth/noise/detection — new terrain for `sound.js`, so it gets its own tests and a likely memory write-back after the build.
- **Five external passes**: echolocation-as-sight (Dark Echo/Stifled/Perception/Muffled Warfare); voice-mimic horror (Yamabiko/Mimic/Echo); grid noise radii (Invisible Inc); stealth two-stage-alert fairness; audio localizability.
- **Deliberately deferred (💡):** microphone input (Stifled uses a real mic) — rejected as a permissions/reliability trap on mobile and untestable headless; the ping is a button, not a shout. Scope for Stage 0 is one drowned region + the Answerer, mirroring Phase 3's single-district Stage 0.
