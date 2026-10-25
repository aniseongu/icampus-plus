// Google Calendar sync for the saved favorite-course schedule. Worker only.
const Gcal = (() => {
  const BASE = 'https://www.googleapis.com/calendar/v3';
  const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
  const PERMISSIONS = {
    permissions: ['identity'],
    origins: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*']
  };
  let queue = Promise.resolve();

  function serialize(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  function failure(code) { return Object.assign(new Error(code), { code }); }

  function clientId(value) {
    return typeof value === 'string' && /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(value.trim())
      ? value.trim() : null;
  }

  async function authorize(interactive) {
    if (!(await chrome.permissions.contains(PERMISSIONS))) throw failure('permission');
    const { gcalClientId } = await chrome.storage.local.get('gcalClientId');
    const id = clientId(gcalClientId);
    if (!id) throw failure('client');
    const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
    const redirect = chrome.identity.getRedirectURL();
    const params = new URLSearchParams({
      client_id: id, response_type: 'token', redirect_uri: redirect,
      scope: SCOPE, state, include_granted_scopes: 'true', prompt: interactive ? 'consent' : 'none'
    });
    let returned;
    try {
      returned = await chrome.identity.launchWebAuthFlow({
        url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params, interactive,
        ...(interactive ? {} : { abortOnLoadForNonInteractive: true, timeoutMsForNonInteractive: 10000 })
      });
    } catch (error) {
      const clientError = /redirect_uri_mismatch|invalid_client|unauthorized_client/i.test(String(error?.message || ''));
      throw failure(clientError ? 'client' : interactive ? 'cancelled' : 'reconnect');
    }
    let url;
    try { url = new URL(returned); } catch { throw failure('client'); }
    if (url.origin + url.pathname !== new URL(redirect).origin + new URL(redirect).pathname) throw failure('client');
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.get('state') !== state) throw failure(interactive ? 'client' : 'reconnect');
    const error = fragment.get('error') || url.searchParams.get('error');
    if (error) throw failure(error === 'redirect_uri_mismatch' || error === 'invalid_client' ? 'client'
      : interactive && error === 'access_denied' ? 'cancelled' : interactive ? 'client' : 'reconnect');
    const token = fragment.get('access_token');
    const seconds = Number(fragment.get('expires_in'));
    if (!token || !Number.isFinite(seconds) || seconds <= 0) {
      throw failure(interactive ? 'client' : 'reconnect');
    }
    await examSessionReady;
    await chrome.storage.session.set({ gcalAccess: { token, exp: Date.now() + seconds * 1000 } });
    return token;
  }

  async function access(force = false) {
    await examSessionReady;
    const saved = (await chrome.storage.session.get('gcalAccess')).gcalAccess;
    if (!force && saved?.token && saved.exp > Date.now() + 60000) return saved.token;
    try { return await authorize(false); }
    catch {
      await chrome.storage.session.remove('gcalAccess');
      throw failure('reconnect');
    }
  }

  async function api(path, method = 'GET', body, retry = true) {
    const token = await access();
    let response;
    try {
      response = await fetch(BASE + path, {
        method, headers: { Authorization: 'Bearer ' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        // A stalled request must not hold the sync queue.
        signal: AbortSignal.timeout(15000)
      });
    } catch { throw failure('network'); }
    if (response.status === 401 && retry) {
      await access(true);
      return api(path, method, body, false);
    }
    if (response.status === 401 || response.status === 403) throw failure('reconnect');
    if (response.status === 429 || response.status >= 500) throw failure('network');
    if (!response.ok) throw failure(String(response.status));
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw failure('network'); }
  }

  async function calendar(force = false) {
    const saved = await chrome.storage.local.get('gcalCalendarId');
    const id = saved.gcalCalendarId;
    if (id && !force) return { id, created: false };
    if (id) {
      try { await api('/calendars/' + encodeURIComponent(id)); return { id, created: false }; }
      catch (error) { if (error.code !== '404') throw error; }
    }
    const created = await api('/calendars', 'POST', { summary: '아캠 플러스', timeZone: 'Asia/Seoul' });
    if (!created?.id) throw failure('network');
    await chrome.storage.local.set({ gcalCalendarId: created.id, gcalEvents: {} });
    return { id: created.id, created: true };
  }

  async function hash(value) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function leads(value) {
    const input = Array.isArray(value) ? value : [1440, 180];
    return [...new Set(input.filter(n => Number.isInteger(n) && n >= 0 && n <= 40320))]
      .sort((a, b) => b - a).slice(0, 5).map(minutes => ({ method: 'popup', minutes }));
  }

  async function desiredEvents(items, leadSetting) {
    const wanted = new Map();
    const reminders = { useDefault: false, overrides: leads(leadSetting) };
    for (const item of items) {
      if (!item || typeof item.key !== 'string' || !item.key || item.done || item.closed === 'offline') continue;
      const due = Date.parse(item.due);
      if (!Number.isFinite(due)) continue;
      const late = Date.parse(item.lateUntil);
      for (const part of Number.isFinite(late) && late > due ? ['main', 'late'] : ['main']) {
        const end = part === 'late' ? late : due;
        // Google reminders count from the event start, so a deadline is a short
        // block ending at it. Only a sitting of three hours or less (a timed exam)
        // spans opening to close, where a reminder before the start is the point.
        const opens = Date.parse(item.opensAt);
        const sitting = item.quiz && part === 'main' && opens < due && due - opens <= 3 * 3600000;
        const start = sitting ? opens : end - 1800000;
        const summary = (part === 'late' ? '[지각 마감] '
          : item.quiz ? '[퀴즈] ' : item.type === '강의' ? '[강의] ' : '[과제] ') + (item.title || '');
        const opensLine = Number.isFinite(opens) && !sitting ? '열림 ' + new Date(opens).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit'
        }) + '\n' : '';
        const event = {
          id: 'icp' + (await hash(item.key + '|' + part)).slice(0, 40), summary,
          description: opensLine + (item.course || '') + '\n' + (item.url || ''),
          start: { dateTime: new Date(start).toISOString(), timeZone: 'Asia/Seoul' },
          end: { dateTime: new Date(end).toISOString(), timeZone: 'Asia/Seoul' },
          reminders,
          extendedProperties: { private: { icampusKey: item.key, icampusPart: part } }
        };
        const sig = (await hash(JSON.stringify([summary, event.start, event.end, event.description, reminders]))).slice(0, 16);
        wanted.set(event.id, { event, sig, end });
      }
    }
    return wanted;
  }

  async function state(problem, count) {
    const old = (await chrome.storage.local.get('gcalState')).gcalState || {};
    const next = problem ? { ...old, problem } : { lastSyncAt: Date.now(), problem: null, count };
    await chrome.storage.local.set({ gcalState: next });
    if (problem === 'reconnect' && old.problem !== 'reconnect') {
      await chrome.notifications.create('icampus-gcal-reconnect', {
        type: 'basic', iconUrl: 'icons/notify-assignment.png',
        title: '구글 캘린더 연결이 끊겼어요',
        message: '아캠 플러스 설정에서 다시 연결해 주세요'
      }).catch(() => {});
    }
  }

  async function sync(forceCalendar = false) {
    if (await examIsActive()) return { error: 'permission' };
    const saved = await chrome.storage.local.get(['icampusSchedule', 'alertLeadMinutes', 'gcalEvents', 'gcalCalendarId']);
    const wanted = await desiredEvents(saved.icampusSchedule?.items || [], saved.alertLeadMinutes);
    let records = saved.gcalEvents && typeof saved.gcalEvents === 'object' ? { ...saved.gcalEvents } : {};
    // Once a day rewrite every event, so one deleted by hand in Google Calendar comes back.
    const { gcalFullAt } = await chrome.storage.local.get('gcalFullAt');
    const full = !Number.isFinite(gcalFullAt) || Date.now() - gcalFullAt > 24 * 60 * 60 * 1000;
    if (full) records = Object.fromEntries(Object.entries(records).map(([id, entry]) => [id, { ...entry, sig: null }]));
    let changed = full || [...wanted].some(([id, entry]) => records[id]?.sig !== entry.sig)
      || Object.keys(records).some(id => !wanted.has(id));
    if (forceCalendar || changed || !saved.gcalCalendarId) {
      const cal = await calendar(true);
      if (cal.created) { records = {}; changed = true; }
      if (changed) {
        const path = '/calendars/' + encodeURIComponent(cal.id) + '/events';
        for (const [id, entry] of wanted) {
          if (await examIsActive()) return { error: 'permission' };
          if (records[id]?.sig === entry.sig) continue;
          try { await api(path + '/' + id, 'PUT', entry.event); }
          catch (error) {
            if (error.code !== '404') throw error;
            try { await api(path, 'POST', entry.event); }
            catch (insertError) {
              if (insertError.code !== '409') throw insertError;
              await api(path + '/' + id, 'PUT', entry.event);
            }
          }
          records[id] = { sig: entry.sig, end: entry.end };
          await chrome.storage.local.set({ gcalEvents: records });
        }
        for (const [id, entry] of Object.entries(records)) {
          if (wanted.has(id)) continue;
          if (await examIsActive()) return { error: 'permission' };
          if (entry.end > Date.now()) {
            try { await api(path + '/' + id, 'DELETE'); }
            catch (error) { if (error.code !== '404' && error.code !== '410') throw error; }
          }
          delete records[id];
          await chrome.storage.local.set({ gcalEvents: records });
        }
      }
    }
    if (full) await chrome.storage.local.set({ gcalFullAt: Date.now() });
    await state(null, wanted.size);
    return { ok: true };
  }

  async function runSync(forceCalendar = false) {
    try { return await sync(forceCalendar); }
    catch (error) {
      if (error.code === 'reconnect') await state('reconnect');
      else await state(error.code === 'permission' ? 'permission' : 'network');
      return { error: error.code === 'reconnect' ? 'permission' : error.code === 'permission' ? 'permission' : 'network' };
    }
  }

  async function syncIfEnabled() {
    const { gcalEnabled } = await chrome.storage.local.get('gcalEnabled');
    if (!gcalEnabled) return;
    return serialize(() => runSync());
  }

  async function message(type) {
    if (type === 'icampus-gcal-status') {
      const saved = await chrome.storage.local.get(['gcalEnabled', 'gcalClientId', 'gcalState', 'gcalCalendarId']);
      return { enabled: saved.gcalEnabled === true, hasClientId: Boolean(clientId(saved.gcalClientId)),
        problem: saved.gcalState?.problem || null, lastSyncAt: saved.gcalState?.lastSyncAt || null,
        count: saved.gcalState?.count || 0, calendar: Boolean(saved.gcalCalendarId) };
    }
    return serialize(async () => {
      if (type === 'icampus-gcal-disconnect') {
        await chrome.storage.local.set({ gcalEnabled: false });
        await examSessionReady;
        const stored = (await chrome.storage.session.get('gcalAccess')).gcalAccess;
        if (stored?.token) {
          try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(stored.token), { method: 'POST', signal: AbortSignal.timeout(10000) }); }
          catch { /* Local disconnect still succeeds. */ }
        }
        await chrome.storage.session.remove('gcalAccess');
        await chrome.storage.local.remove('gcalEvents');
        const old = (await chrome.storage.local.get('gcalState')).gcalState || {};
        await chrome.storage.local.set({ gcalState: { ...old, problem: null } });
        return { ok: true };
      }
      if (type === 'icampus-gcal-connect') {
        if (await examIsActive()) return { error: 'permission' };
        if (!clientId((await chrome.storage.local.get('gcalClientId')).gcalClientId)) return { error: 'client' };
        try {
          if (!(await chrome.permissions.contains(PERMISSIONS))) return { error: 'permission' };
          await authorize(true);
        } catch (error) {
          return { error: ['cancelled', 'client', 'permission'].includes(error.code) ? error.code : 'network' };
        }
        const result = await runSync(true);
        if (result.ok) await chrome.storage.local.set({ gcalEnabled: true });
        return result;
      }
      if (type === 'icampus-gcal-sync') {
        if ((await chrome.storage.local.get('gcalEnabled')).gcalEnabled !== true) return { error: 'permission' };
        return runSync();
      }
      return { error: 'permission' };
    });
  }

  return { message, syncIfEnabled };
})();
