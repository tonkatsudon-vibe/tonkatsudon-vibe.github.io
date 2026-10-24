// GameBoy Plugin by Tonkatsudon (https://github.com/tonkatsudon-vibe/gameboy-chrome-extension)
// MIT License, see LICENSE. Keep this notice in copies and forks.

// When popup.html is served as a plain web page there is no chrome.storage.
// Stand in for the parts popup.js uses (get / getKeys / set / remove), all in
// IndexedDB (ROMs are too big for localStorage's quota). "session" holds the
// resume snapshots; on a phone the page can be thrown away whenever the screen
// locks or the app is closed, so they're kept for good rather than per tab,
// and the game picks up where it was.
// Inside the extension this file does nothing.

(() => {
  if (globalThis.chrome?.storage?.local) return;

  // chrome.storage.get accepts null (everything), a key, a key list, or an
  // object of keys with defaults.
  const keyList = (keys) => {
    if (keys == null) return null;.
    if (typeof keys === 'string') return [keys];
    return Array.isArray(keys) ? keys : Object.keys(keys);
  };
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

  // Only the keys asked for (null: everything), so reading a pref doesn't
  // load every stored ROM.
  const read = (keys) => tx('readonly', (store) => {
    const result = { value: {} };
    const wanted = keyList(keys);
    if (store === memory) {
      for (const [k, v] of memory) if (!wanted || wanted.includes(k)) result.value[k] = v;
      return result;
    }
    if (wanted) {
      for (const k of wanted) {
        const req = store.get(k);
        req.onsuccess = () => { if (req.result !== undefined) result.value[k] = req.result; };
      }
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
    get: async (keys) => pick(await read(keys), keys),
    getKeys: async () => Object.keys(await read(null)).filter((k) => !k.startsWith(SESSION)),
    set: (items) => tx('readwrite', (store) => {
      for (const [k, v] of Object.entries(items)) store === memory ? memory.set(k, v) : store.put(v, k);
      return {};
    }),
    remove: (keys) => tx('readwrite', (store) => {
      for (const k of [].concat(keys)) store.delete(k);
      return {};
    }),
  };

  // The snapshots sit in the same store under their own prefix.
  const SESSION = 'session:';
  const session = {
    get: async (keys) => {
      const got = await read(keyList(keys).map((k) => SESSION + k));
      const out = {};
      for (const [k, v] of Object.entries(got)) out[k.slice(SESSION.length)] = v;
      return pick(out, keys);
    },
    set: (items) => local.set(Object.fromEntries(Object.entries(items).map(([k, v]) => [SESSION + k, v]))),
    remove: (keys) => local.remove([].concat(keys).map((k) => SESSION + k)),
  };

  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.storage = { local, session };
})();
