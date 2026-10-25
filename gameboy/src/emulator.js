// GameBoy Plugin by Tonkatsudon (https://github.com/tonkatsudon-vibe/gameboy-chrome-extension)
// MIT License, see LICENSE. Keep this notice in copies and forks.

// Runs inside the sandboxed emulator.html, which popup.html embeds as the
// Game Boy's screen. Messages with popup.js:
//   → { type: 'ready' }                      listening
//   ← { type: 'load', fileName, name, core, rom, save, state }
//   → { type: 'started' }
//   ← { type: 'input', index, value }        a Game Boy button went down/up
//   ← { type: 'pause' } / { type: 'play' }
//   → { type: 'save', game, data }           battery save changed (keep forever)
//   → { type: 'state', game, data }          snapshot to resume after a page change
//   ← { type: 'flush' }                      send save + state now
//
// The sandbox has an opaque origin, so IndexedDB and localStorage throw here;
// popup.js stores everything instead.

// Pinned so an upstream release can't change behaviour under us.
const CDN = 'https://cdn.jsdelivr.net/npm/@emulatorjs/';
const VERSION = '4.2.3';
// EmulatorJS system → the libretro core it runs (Game Boy / Color, Advance).
const CORES = { gb: 'gambatte', gba: 'mgba' };
const CORE_BUILDS = ['wasm', 'legacy-wasm', 'thread-wasm', 'thread-legacy-wasm'];
const SAVE_EVERY = 4000;
const STATE_EVERY = 2000;

// Merely reading window.localStorage throws in an opaque-origin sandbox, and
// EmulatorJS probes it. Give it a throwaway store, and hide IndexedDB so its
// database layer falls back instead of rejecting.
(() => {
  const mem = new Map();
  const store = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  try { Object.defineProperty(window, 'localStorage', { value: store, configurable: true }); } catch {}
  try { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); } catch {}
})();

// Safari keeps audio silent unless it's started from a tap or key press, and
// those never reach this frame. Served as a web page, popup.js is the same
// origin and calls resumeAudio() from inside its own tap and key handlers.
// Before the game has made its AudioContext, that starts one for it to take.
(() => {
  const Native = window.AudioContext;
  if (!Native) return;
  const contexts = [];
  let primed = null;
  window.AudioContext = class extends Native {
    constructor(options) {
      if (primed && !options?.sampleRate) {
        const ctx = primed;
        primed = null;
        return ctx;
      }
      super(options);
      contexts.push(this);
    }
  };
  // Like the boot sound: play through the iPhone's silent switch (iOS 17+).
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  window.resumeAudio = () => {
    if (!contexts.length && !primed) contexts.push((primed = new Native()));
    for (const ctx of contexts) if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  };
})();

const post = (msg, transfer) => parent.postMessage(msg, '*', transfer);
let loaded = false;
let game = null; // echoed on save/state so a late message can't land on the next cartridge
let paused = false;
let lastSave = null;

// Cheap change detector for a ~32KB SRAM buffer (FNV-1a).
function hash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return `${bytes.length}:${h >>> 0}`;
}

const gm = () => (window.EJS_emulator?.started ? window.EJS_emulator.gameManager : null);

function pushSave() {
  const g = gm();
  if (!g) return;
  let data;
  try { data = g.getSaveFile(); } catch { return; } // also flushes SRAM to the core's FS
  if (!data?.length) return;
  const h = hash(data);
  if (h === lastSave) return;
  lastSave = h;
  const copy = data.slice();
  post({ type: 'save', game, data: copy.buffer }, [copy.buffer]);
}

function pushState() {
  const g = gm();
  if (!g) return;
  try {
    const copy = g.getState().slice();
    post({ type: 'state', game, data: copy.buffer }, [copy.buffer]);
  } catch {}
}

function restore(save, state) {
  const g = gm();
  if (!g) return;
  try {
    if (save) {
      const bytes = new Uint8Array(save);
      const path = g.getSaveFilePath();
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir) try { g.FS.mkdirTree(dir); } catch {}
      g.FS.writeFile(path, bytes);
      g.loadSaveFiles();
      lastSave = hash(bytes);
    }
    // A snapshot from the previous page picks up exactly where it left off.
    if (state) g.loadState(new Uint8Array(state));
  } catch (err) {
    console.warn('[GameBoy Plugin] restore failed:', err);
  }
}

function load({ fileName, name, core, rom, save, state }) {
  if (loaded) return; // one cartridge per frame; popup.js reloads us to swap
  loaded = true;
  game = fileName;

  const data = `${CDN}emulatorjs@${VERSION}/data/`;
  const lib = CORES[core];
  const cores = `${CDN}core-${lib}@${VERSION}/`;
  // The npm build has no minified bundle, so the loader logs a warning and
  // falls back to the individual source files. That's expected.
  const paths = { [`${lib}.json`]: `${cores}reports/${lib}.json` };
  for (const build of CORE_BUILDS) paths[`${lib}-${build}.data`] = `${cores}${lib}-${build}.data`;

  Object.assign(window, {
    EJS_player: '#game',
    EJS_core: core,
    EJS_gameUrl: new File([rom], fileName),
    EJS_gameName: name,
    EJS_startOnLoaded: true,
    EJS_pathtodata: data,
    EJS_paths: paths,
    EJS_disableDatabases: true,
    EJS_disableLocalStorage: true,
    // popup.js takes the keys and forwards them. Served as a web page this frame
    // is the same origin, so its own focus grab would swallow them instead.
    EJS_noAutoFocus: true,
    EJS_onGameStart() {
      restore(save, state);
      if (paused) window.EJS_emulator.pause(true);
      setInterval(pushSave, SAVE_EVERY);
      setInterval(() => { if (!paused) pushState(); }, STATE_EVERY);
      post({ type: 'started' });
    },
  });

  const script = document.createElement('script');
  script.src = `${data}loader.js`;
  script.onerror = () => post({ type: 'error', message: 'No connection' });
  document.body.append(script);
}

window.addEventListener('message', (e) => {
  if (e.source !== parent || !e.data) return;
  const msg = e.data;
  if (msg.type === 'load') load(msg);
  else if (msg.type === 'input') gm()?.simulateInput(0, msg.index, msg.value);
  else if (msg.type === 'pause') { paused = true; window.EJS_emulator?.pause(true); pushState(); pushSave(); }
  else if (msg.type === 'play') { paused = false; window.EJS_emulator?.play(true); }
  else if (msg.type === 'flush') { pushSave(); pushState(); }
});

post({ type: 'ready' });
