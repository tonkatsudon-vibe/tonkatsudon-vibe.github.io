// GameBoy Plugin by Tonkatsudon (https://github.com/tonkatsudon-vibe/gameboy-chrome-extension)
// MIT License, see LICENSE. Keep this notice in copies and forks.

// When popup.html is served as a plain web page there is no chrome.storage.
// Stand in for the parts popup.js uses (get / getKeys / set / remove):
// local → IndexedDB (ROMs are too big for localStorage's quota),
// session → sessionStorage (resume snapshots survive a reload of this tab).
// Inside the extension this file does nothing.

(() => {
  if (globalThis.chrome?.storage?.local) return;

  // chrome.storage.get accepts null (everything), a key, a key list, or an
  // object of keys with defaults.
  function pick(all, keys) {
    if (keys == null) return { ...all };
    if (typeof keys === 'string') keys = [keys];
    const out = {};
    if (Array.isArray(keys)) {
      for (const k of keys) if (k in all) out[k] = all[k];
    } else {
      for (const [k, def] of Object.entries(keys)) out[k] = k in all ? all[k] : def;
    }
    return out;
  }

  // Ask the browser to keep ROMs and saves rather than clear them when space
  // runs low or the site goes unvisited (Safari does both). It may say no.
  navigator.storage?.persist?.().catch(() => {});

  // Some browsers refuse IndexedDB (private windows, blocked site data,
  // sandboxed previews). Then everything is kept in memory: the game still
  // plays, it just forgets on reload.
  const memory = new Map();
  const dbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open('gameboy-plugin', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    console.warn('[GameBoy Plugin] no IndexedDB, saves last until reload:', err);
    return null;
  });

  // run gets the object store, or the in-memory Map when there's no database.
  function tx(mode, run) {
    return dbReady.then((db) => (!db ? run(memory).value : new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const result = run(t.objectStore('kv'));
      t.oncomplete = () => resolve(result.value);
      t.onerror = () => reject(t.error);
    })));
  }

  const readAll = () => tx('readonly', (store) => {
    const result = { value: {} };
    if (store === memory) {
      for (const [k, v] of memory) result.value[k] = v;
      return result;
    }
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      result.value[cur.key] = cur.value;
      cur.continue();
    };
    return result;
  });

  const local = {
    get: async (keys) => pick(await readAll(), keys),
    getKeys: async () => Object.keys(await readAll()),
    set: (items) => tx('readwrite', (store) => {
      for (const [k, v] of Object.entries(items)) store === memory ? memory.set(k, v) : store.put(v, k);
      return {};
    }),
    remove: (keys) => tx('readwrite', (store) => {
      for (const k of [].concat(keys)) store.delete(k);
      return {};
    }),
  };

  const PREFIX = 'gameboy:';
  // Reading sessionStorage can throw too; then there's just nothing to resume.
  function sessionAll() {
    const all = {};
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k.startsWith(PREFIX)) all[k.slice(PREFIX.length)] = JSON.parse(sessionStorage.getItem(k));
      }
    } catch {}
    return all;
  }

  const session = {
    get: async (keys) => pick(sessionAll(), keys),
    getKeys: async () => Object.keys(sessionAll()),
    // May throw on quota; popup.js already ignores failed snapshot writes.
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) sessionStorage.setItem(PREFIX + k, JSON.stringify(v));
    },
    remove: async (keys) => {
      try {
        for (const k of [].concat(keys)) sessionStorage.removeItem(PREFIX + k);
      } catch {}
    },
  };

  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.storage = { local, session };
})();
