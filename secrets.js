// Canvas personal tokens belong to the extension service worker only.
const CanvasToken = (() => {
  const DB = 'icampus-secrets';
  const STORE = 'kv';
  const KEY = 'canvasToken';

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function read() {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function write(record) {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(record, KEY);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }

  async function mark(token, field) {
    if (!token) return;
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const request = store.get(KEY);
        request.onsuccess = () => {
          const record = request.result;
          if (record?.token === token && (field !== 'lastOkAt' || !record.rejectedAt))
            store.put({ ...record, [field]: Date.now() }, KEY);
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }

  function publicStatus(record) {
    return {
      set: Boolean(record?.token), name: record?.name || null,
      userId: record?.userId || null, savedAt: record?.savedAt || null,
      lastOkAt: record?.lastOkAt || null, rejectedAt: record?.rejectedAt || null
    };
  }

  async function save(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token || token.length > 200 || !/^[A-Za-z0-9~]+$/.test(token)) throw { code: 'invalid-format' };
    let response, user;
    try {
      response = await fetch('https://canvas.skku.edu/api/v1/users/self', {
        credentials: 'omit',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(8000)
      });
      if (response.status === 401) throw { code: 'rejected' };
      if (!response.ok) throw { code: 'network' };
      user = JSON.parse((await response.text()).replace(/^while\(1\);\s*/, ''));
      if (!user?.id || typeof user.name !== 'string') throw { code: 'network' };
    } catch (error) {
      if (error?.code !== 'rejected') reportError('worker', 'Canvas 토큰 확인 실패: ' +
        String(error?.message || error?.code || 'network'), { stack: error?.stack });
      throw { code: error?.code === 'rejected' ? 'rejected' : 'network' };
    }
    const saved = (await chrome.storage.local.get('icampusSchedule')).icampusSchedule;
    if (saved?.userId && String(saved.userId) !== String(user.id)) throw { code: 'other-account' };
    const now = Date.now();
    const record = { token, userId: String(user.id), name: user.name,
      savedAt: now, lastOkAt: now, rejectedAt: null };
    await write(record);
    return publicStatus(record);
  }

  return {
    get: async () => { const record = await read(); return record?.rejectedAt ? null : record?.token || null; },
    status: async () => publicStatus(await read()),
    save,
    clear: async () => { await write(null); return publicStatus(null); },
    markRejected: token => mark(token, 'rejectedAt'),
    markOk: token => mark(token, 'lastOkAt')
  };
})();

// Google OAuth credentials use a separate worker-only record from Canvas tokens.
const GcalSecret = (() => {
  const DB = 'icampus-secrets';
  const STORE = 'kv';
  const KEY = 'gcalOAuth';
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transact(mode, operation) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = operation(transaction.objectStore(STORE));
        let value = null;
        request.onsuccess = () => { value = request.result || null; };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }
  return {
    get: () => transact('readonly', store => store.get(KEY)),
    set: record => transact('readwrite', store => store.put(record, KEY)),
    clear: () => transact('readwrite', store => store.delete(KEY))
  };
})();
