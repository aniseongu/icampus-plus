// Error records contain only extension-generated text and a URL without search/hash.
const ErrorLog = (() => {
  const SLUG = 'icampus-check';
  const HOST = 'kr.aniseongu.whale_error_log';
  const PENDING_KEY = 'errorLogPending';
  const DEDUPE_KEY = 'errorLogRecent';
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const isWorker = typeof document === 'undefined';
  const isContent = !isWorker && location.protocol !== 'chrome-extension:';
  const recent = new Map();
  let queue = Promise.resolve();

  function cleanText(value, limit) {
    return String(value ?? '').replace(/(?:https?|chrome-extension|file):\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        if (/^\/courses\/\d+\/quizzes\/\d+\/take(?:\/|$)/.test(url.pathname)) return '[시험 주소]';
        if (url.protocol === 'file:') return '[파일 주소]';
        return url.origin + url.pathname;
      }
      catch { return '[URL]'; }
    }).replace(/\b(token|access_token|refresh_token|password|passwd|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]').replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]').slice(0, limit);
  }

  function cleanUrl(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return undefined;
      if (/^\/courses\/\d+\/quizzes\/\d+\/take(?:\/|$)/.test(url.pathname)) return undefined;
      return (url.origin + url.pathname).slice(0, 500);
    } catch { return undefined; }
  }

  function serialize(work) {
    const next = queue.then(() => {
      // Popup and worker share an origin; keep their pending-log writes in one order.
      if (!isContent && globalThis.navigator?.locks) {
        return globalThis.navigator.locks.request('icampus-error-log', work);
      }
      return work();
    });
    queue = next.catch(() => {});
    return next;
  }

  function fitEntry(entry) {
    const size = () => new TextEncoder().encode(JSON.stringify(entry)).length;
    if (size() <= 12000) return;
    entry.truncated = true;
    for (const field of ['stack', 'message']) {
      if (!entry[field] || size() <= 12000) continue;
      let low = 0, high = entry[field].length;
      const original = entry[field];
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        entry[field] = original.slice(0, mid);
        if (size() <= 12000) low = mid;
        else high = mid - 1;
      }
      entry[field] = original.slice(0, low);
    }
  }

  async function deliver(entry) {
    const saved = await chrome.storage.local.get(PENDING_KEY);
    const fresh = item => Number.isFinite(Date.parse(item?.at)) && Date.parse(item.at) >= Date.now() - MAX_AGE_MS;
    const pending = Array.isArray(saved[PENDING_KEY]) ? saved[PENDING_KEY].filter(fresh).slice(-50) : [];
    const next = entry ? [...pending, entry].slice(-50) : pending;
    if (next.length) await chrome.storage.local.set({ [PENDING_KEY]: next });
    else await chrome.storage.local.remove(PENDING_KEY);
    while (true) {
      const current = await chrome.storage.local.get(PENDING_KEY);
      const all = Array.isArray(current[PENDING_KEY]) ? current[PENDING_KEY] : [];
      const remaining = all.filter(fresh);
      if (remaining.length !== all.length) {
        if (remaining.length) await chrome.storage.local.set({ [PENDING_KEY]: remaining });
        else await chrome.storage.local.remove(PENDING_KEY);
      }
      if (!remaining.length) break;
      if (typeof chrome.runtime.sendNativeMessage !== 'function' ||
          !await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) break;
      const batch = [];
      for (const item of remaining) {
        const candidate = [...batch, item];
        if (new TextEncoder().encode(JSON.stringify({ type: 'log', slug: SLUG, entries: candidate })).length > 60000) break;
        batch.push(item);
      }
      if (!batch.length) break;
      try {
        const result = await chrome.runtime.sendNativeMessage(HOST, { type: 'log', slug: SLUG, entries: batch });
        if (!result?.ok) throw new Error('Native host rejected entries');
        const confirmed = new Set(batch.map(item => item.id));
        const latest = await chrome.storage.local.get(PENDING_KEY);
        const keep = (Array.isArray(latest[PENDING_KEY]) ? latest[PENDING_KEY] : [])
          .filter(item => !confirmed.has(item.id));
        if (keep.length) await chrome.storage.local.set({ [PENDING_KEY]: keep });
        else await chrome.storage.local.remove(PENDING_KEY);
      } catch { break; }
    }
  }

  function flushPending() {
    return serialize(() => deliver()).catch(() => {});
  }

  async function reportError(source, message, extra = {}) {
    if (typeof source !== 'string' || typeof message !== 'string' || !message) return;
    const safeMessage = cleanText(message, 2000);
    const at = new Date().toISOString();
    const entry = {
      id: crypto.randomUUID(), at, slug: SLUG, version: chrome.runtime.getManifest().version,
      source: source.slice(0, 40), message: safeMessage
    };
    const url = cleanUrl(extra.url || (isContent ? location.href : ''));
    if (url) entry.url = url;
    if (extra.stack) entry.stack = cleanText(extra.stack, 4000);
    fitEntry(entry);
    const key = entry.source + '\n' + safeMessage;

    return serialize(async () => {
      if (isContent) {
        // The worker's exam-status check uses ExamMode's URL judgement.
        try {
          const state = await chrome.runtime.sendMessage({ type: 'exam-status' });
          if (!state || (state.guard && (state.manual || state.examTabs > 0))) return;
          await chrome.runtime.sendMessage({ type: 'icampus-error-log',
            source: entry.source, message: entry.message, url: entry.url, stack: entry.stack });
        } catch { /* Logging must never disrupt playback. */ }
        return;
      }
      let seen = recent;
      if (isWorker) {
        const saved = await chrome.storage.session.get(DEDUPE_KEY);
        seen = new Map(Object.entries(saved[DEDUPE_KEY] || {}));
      }
      const now = Date.now();
      const previous = seen.get(key);
      const last = typeof previous === 'number' ? { at: previous, repeated: 0 } : previous;
      if (last && now - last.at < 60000) {
        seen.set(key, { at: last.at, repeated: (last.repeated || 0) + 1 });
        if (isWorker) await chrome.storage.session.set({ [DEDUPE_KEY]: Object.fromEntries([...seen].slice(-100)) });
        return;
      }
      if (last?.repeated > 0) entry.repeated = last.repeated;
      seen.set(key, { at: now, repeated: 0 });
      for (const [oldKey, value] of seen) {
        const time = typeof value === 'number' ? value : value.at;
        if (now - time > 60000) seen.delete(oldKey);
      }
      if (isWorker) await chrome.storage.session.set({ [DEDUPE_KEY]: Object.fromEntries([...seen].slice(-100)) });
      await deliver(entry);
    }).catch(() => {});
  }

  return { reportError, cleanUrl, flushPending };
})();
const reportError = ErrorLog.reportError;
