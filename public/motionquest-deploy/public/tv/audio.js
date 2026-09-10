// Sound — music and effects for the TV screen.
//
// Sound lives entirely on the TV. The phone is a controller: it is in the
// player's pocket or propped under the telly, and audio coming out of it
// would be both quieter and out of sync with what is on screen.
//
// TWO DIFFERENT MECHANISMS, on purpose:
//
//   * EFFECTS go through the Web Audio API, decoded once into memory and
//     fired from a buffer source. An <audio> element has tens of
//     milliseconds of start latency and cannot overlap with itself — you
//     would hear one coin instead of a run of them. Buffers start on the
//     next audio frame and any number can overlap.
//
//   * MUSIC goes through a plain <audio> element with loop=true. A 36-second
//     track decoded into memory is several megabytes of RAM on a device that
//     has very little; an element streams it and loops seamlessly for free.
//
// AUTOPLAY: browsers refuse to start audio until the user has interacted
// with the page. On a TV the first interaction is the remote's OK button, so
// unlock() is called from the existing input handlers. Until then everything
// is queued silently rather than throwing — see the `unlocked` checks below.
//
// Nothing here is required for the game to work. If a file is missing, the
// decode fails, or the device has no audio at all, every function becomes a
// no-op and play continues in silence.

const SFX_FILES = {
  coin: 'sfx_coin_collect.mp3',
  gem: 'sfx_gem_collect.mp3',
  heart: 'sfx_heart_collect.mp3',
  star: 'sfx_life_collect.mp3',
  jump: 'sfx_jump.mp3',
  punch: 'sfx_punch.mp3',
};

const MUSIC_FILES = {
  dino: 'music_dino.mp3',
  rome: 'music_rome.mp3',
  present: 'music_present.mp3',
  future: 'music_future.mp3',
};

const MUTE_KEY = 'motionquest_muted';

let ctx = null;
let sfxGain = null;
let unlocked = false;
let muted = false;
const buffers = new Map();      // name -> AudioBuffer
let musicEl = null;
let currentTrack = null;
// Whether the game currently WANTS music playing, kept separate from
// whether the element actually is. See the "why the first level was
// silent" note above tryStartMusic().
let musicWanted = false;
// Set when a play() attempt was refused by the browser's autoplay policy,
// cleared the moment one succeeds. The TV reads this (musicBlocked()) to
// show a "press OK for sound" hint, which is the only way a player sitting
// on a sofa can supply the gesture the browser is holding out for.
let musicBlocked = false;

try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* private mode */ }

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.75;
  sfxGain.connect(ctx.destination);
  return ctx;
}

/** Decodes every effect into memory. Safe to call before unlock(). */
export async function preloadSfx() {
  const audio = ensureContext();
  if (!audio) return;
  await Promise.all(Object.entries(SFX_FILES).map(async ([name, file]) => {
    try {
      const res = await fetch(`./audio/${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffers.set(name, await audio.decodeAudioData(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`[audio] ${file} unavailable:`, err.message);
    }
  }));
}

/**
 * The one place that ever asks the element to roll.
 *
 * 2026-09-09 — "the dino level has no music". The cause was not the track,
 * the file or the era: it was WHERE the play() attempt was being made from.
 *
 * A browser only starts audio inside a genuine user gesture, and on the TV
 * the only genuine gestures are Fire TV remote presses. Everything the
 * phone does arrives as a WebSocket message, which is NOT a gesture no
 * matter how deliberate the player was at the other end. MotionQuest is
 * designed to be played from the phone, so a player can pair, pick a level
 * and run a whole race without the TV ever seeing one — and the old code
 * took its single shot at play() at era-switch time, let the rejection fall
 * into an empty .catch(), and never tried again.
 *
 * It showed up on the Primeval Valley specifically because that is the only
 * era unlocked on a fresh install: every LATER era can only be reached by
 * finishing an earlier one, and the results screen in between is one of the
 * places a player does press OK. So the first level anyone ever plays is
 * the one most likely to be silent — which reads exactly like "the dino
 * level has no music".
 *
 * The fix is to stop treating the start as a one-shot. `musicWanted` records
 * the intent, and this retries it on every unlock() — i.e. on every remote
 * press AND every phone message — so whichever one first happens to carry a
 * real gesture is the one that gets the music going. If the browser is still
 * refusing, `musicBlocked` lets the TV say so on screen rather than leaving
 * the player wondering.
 */
function tryStartMusic() {
  if (!musicWanted || muted || !unlocked || !musicEl || !musicEl.paused) return;
  const attempt = musicEl.play();
  // Older WebViews return undefined from play() rather than a promise.
  if (!attempt || typeof attempt.then !== 'function') { musicBlocked = false; return; }
  attempt.then(
    () => { musicBlocked = false; },
    () => { musicBlocked = true; },
  );
}

/**
 * Called from any input that might carry a user gesture. Browsers start an
 * AudioContext suspended and only allow resuming inside a genuine input
 * handler, so this has to be driven by the game's existing key/message
 * handlers rather than happening on load. Cheap and safe to call often —
 * that is the point, since we cannot tell from here which call is the one
 * carrying the gesture.
 */
export function unlock() {
  const audio = ensureContext();
  if (!audio) return;
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  unlocked = true;
  tryStartMusic();
}

/** True when music is wanted but the browser is still refusing to start it. */
export function isMusicBlocked() { return musicWanted && !muted && musicBlocked; }

/**
 * Fires an effect. `rate` re-pitches it — used for the moves the pack has no
 * dedicated sound for (see the call sites in game.js), which is a normal
 * game-audio trick rather than a shortcut: the same sample at a different
 * pitch reads as a related but distinct action.
 */
export function sfx(name, { rate = 1, gain = 1 } = {}) {
  if (muted || !unlocked || !ctx) return;
  const buffer = buffers.get(name);
  if (!buffer) return;
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    if (gain === 1) {
      src.connect(sfxGain);
    } else {
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(sfxGain);
    }
    src.start();
  } catch { /* a failed effect must never interrupt the game */ }
}

/**
 * Starts (or switches to) an era's music loop.
 *
 * 2026-09-09 ("the dino level has no music"). This used to return early
 * whenever `currentTrack === era`, which quietly conflated two different
 * things: "this track is already SELECTED" and "this track is already
 * PLAYING". They come apart on the most ordinary route through the game:
 *
 *   play a level -> pause (Back) -> exit to the menu (Back again)
 *   -> pick the SAME level again
 *
 * pauseGame() pauses the element, exitToMenu() never resumed it, and then
 * playMusic() saw its own era already in `currentTrack` and did nothing —
 * so the whole next run was silent, with no way to get the music back short
 * of choosing a different era or reloading the page. It reads as "this
 * level has no music" because the level you replay most is the one you
 * notice it on, and the first era is the one everybody replays.
 *
 * So the early-out now only skips the expensive part (re-assigning `src`,
 * which would restart the track from the top mid-run). Whether the element
 * should actually be rolling is re-decided every time, unconditionally —
 * and if the browser won't have it yet, tryStartMusic() keeps asking.
 */
export function playMusic(era) {
  const file = MUSIC_FILES[era];
  if (!file) return;
  if (!musicEl) {
    musicEl = new Audio();
    musicEl.loop = true;
    musicEl.volume = 0.38;   // well under the effects: this sits behind play
    // Autoplay-blocked audio can also surface as a stalled element rather
    // than a rejected promise, so treat actually playing as the only
    // evidence that it worked.
    musicEl.addEventListener('playing', () => { musicBlocked = false; });
  }
  // Only re-point the element when the era genuinely changed — assigning
  // the same src again would restart the loop from zero.
  if (currentTrack !== era) {
    currentTrack = era;
    musicEl.src = `./audio/${file}`;
  }
  musicWanted = true;
  tryStartMusic();
}

export function pauseMusic() {
  musicWanted = false;
  if (musicEl) musicEl.pause();
}

export function resumeMusic() {
  if (!currentTrack) return;
  musicWanted = true;
  tryStartMusic();
}

export function stopMusic() {
  currentTrack = null;
  musicWanted = false;
  if (musicEl) { musicEl.pause(); musicEl.currentTime = 0; }
}

export function isMuted() { return muted; }

/**
 * Current music state, for tests. The <audio> element is deliberately not in
 * the DOM — it needs no layout and nothing should be able to click it — so
 * there is no way to inspect it from the page without this.
 */
export function musicState() {
  // `paused` is the field that matters and the one this was missing: the
  // 2026-09-09 silent-level bug had a perfectly correct `track` and `src`
  // the whole time it was making no sound, so a test that only checked
  // those two could never have caught it.
  return musicEl
    ? {
        track: currentTrack,
        src: musicEl.getAttribute('src'),
        loop: musicEl.loop,
        volume: musicEl.volume,
        paused: musicEl.paused,
        currentTime: musicEl.currentTime,
        wanted: musicWanted,
        blocked: isMusicBlocked(),
      }
    : { track: currentTrack, src: null, loop: null, volume: null, paused: true, currentTime: 0, wanted: musicWanted, blocked: false };
}

/** Returns the new muted state, and persists it for next time. */
export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
  if (muted) {
    if (musicEl) musicEl.pause();
  } else {
    // Unmuting is itself a button press, i.e. a real gesture — which makes
    // it one of the reliable ways out of an autoplay block.
    tryStartMusic();
  }
  return muted;
}
