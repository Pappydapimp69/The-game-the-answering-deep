// Wren's spoken lines, keyed off live quest-chain progress rather than one
// flat array shown identically at every stage of the game — the actual fix
// for "the quest dialog needs to be rewritten, there really isn't anything
// there right now." Mirrors the priority structure src/app/game.js's own
// computeGuide() already uses for the HUD banner (most-progressed state
// first, falling through to earlier stages) but written as something Wren
// would actually SAY, not a one-line objective hint.
export function wrenDialogFor(world) {
  const q = world.quests;
  const done = (id) => !!q.completed[id];
  const active = (id) => !!q.active[id];

  if (world.arc.complete) {
    return [
      'Whatever you decided down there — it’s done now, one way or the other.',
      'Go on, up. I’ve said what I came to say.',
    ];
  }
  if (world.arc.bossSpawned || done('sound-the-deep')) {
    return [
      'It’s down there now, in the hollow, wearing whatever it’s learned of you.',
      'When it falls, you’ll have to say what happens to the voice it stole. Decide that now, not when it’s looking at you with your own face.',
    ];
  }
  if (active('sound-the-deep') || q.offered['sound-the-deep']) {
    return [
      'Last one. It’s learned enough of your voice to answer for you now, given the chance.',
      'Something stands guard over what you’re after, too — it won’t come looking for you, and it won’t be talked out of standing there either.',
      'Bring back the shard, reach the hollow. I’ll be here when it’s done.',
    ];
  }
  if (active('the-sounding-line')) {
    return ['There’s a line down here somewhere — sounding-line, an old surveyor’s tool. Bring it back and I’ll tell you what’s left.'];
  }
  if (done('the-fleeing-kind') || done('the-burning-kind')) {
    return ['You’ve got the measure of one of them, at least. There’s still the other, if you want it — or move on, your call.'];
  }
  if (
    active('the-fleeing-kind') || active('the-burning-kind') || active('guard-the-flame') || done('guard-the-flame')
    || q.offered['the-fleeing-kind'] || q.offered['the-burning-kind'] || q.offered['guard-the-flame']
  ) {
    return [
      'Three ways to spend your time down here now. One runs — chase it before it learns your rhythm. One burns — the real thing this whole reach fears.',
      'And if you’d rather guard what’s already lit than hunt what isn’t: light every dead torch you find, and mind the thing that only wants to put them back out.',
    ];
  }
  if (active('learn-to-listen')) return ['Go on, then. It won’t come to you.'];
  if (done('into-the-dark')) {
    return [
      'Something’s been circling since you started calling — hunched, quiet, close to the ground. Kill one so I know you can hear it coming.',
      'And there are dead torches scattered through here, if you’d rather light the dark for good instead of a heartbeat at a time.',
    ];
  }
  if (active('into-the-dark')) return ['Go on, to Marrow. I’ll be here.'];
  return [
    'You came down. Most people, you say "the sea answered" and they leave it at that.',
    'It didn’t used to answer. That’s the thing. You’d call, and nothing. Now you call and it calls back — a beat late, wearing your voice.',
    'Marrow can teach you to listen properly before it learns YOUR name. Go on.',
  ];
}
