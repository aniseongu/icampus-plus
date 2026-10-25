// Google Calendar sync for the saved favorite-course schedule. Worker only.
const Gcal = (() => {
  const BASE = 'https://www.googleapis.com/calendar/v3';
  const SCOPE_BASE = 'https://www.googleapis.com/auth/calendar.app.created';
  // Read-only calendar list, only to find an existing 아캠 플러스 calendar so every
  // Whale profile writes to one calendar (D-027).
  const SCOPE_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const NAME = '아캠 플러스';
  const MARK = '[icampus-plus]';
  const DESCRIPTION = '아캠 플러스가 과제 마감을 맞추는 캘린더예요. 이름은 바꿔도 돼요. ' + MARK;
  const PERMISSIONS = {
    permissions: ['identity'],
    origins: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*']
  };
  let queue = Promise.resolve();
  let connecting = false;
  let connectFailureReason = 'unknown';
  let connectSyncFailed = false;
  let recentGrantAt = 0;
  let lastAutoResult = null;
  let lastAutoFinishedAt = 0;
  let createAttempted = false;
  const PENDING = 'gcalConnectPending';
  const GRANT = 'gcalGrantAt';

  function serialize(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  function failure(code, reason = 'unknown', detail = '') {
    return Object.assign(new Error(code), { code, reason, detail });
  }

  function secret(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length >= 10 && trimmed.length <= 200 && /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : null;
  }

  function oauthReason(value) {
    if (value === 'login_required') return 'google-login';
    if (value === 'account_selection_required') return 'account-choice';
    if (value === 'consent_required' || value === 'interaction_required') return 'consent';
    return 'unknown';
  }

  async function rememberToken(token, seconds, scope) {
    if (!token || !Number.isFinite(seconds) || seconds <= 0) throw failure('network');
    if (typeof scope === 'string') {
      await chrome.storage.local.set({ gcalListGranted: scope.split(/\s+/).includes(SCOPE_LIST) });
    }
    await examSessionReady;
    await chrome.storage.session.set({ gcalAccess: { token, exp: Date.now() + seconds * 1000 } });
    return token;
  }

  function randomString() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function tokenRequest(params, exchange = false) {
    let response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params), signal: AbortSignal.timeout(15000)
      });
    } catch (error) { throw failure('network', error?.name === 'TimeoutError' ? 'timeout' : 'network'); }
    let data;
    try { data = await response.json(); } catch { throw failure('network'); }
    if (!response.ok) {
      if (data?.error === 'invalid_client')
        throw failure(exchange ? 'secret' : 'reconnect', 'client-secret', String(response.status));
      if (data?.error === 'invalid_grant') throw failure('reconnect', exchange ? 'unknown' : 'token-revoked');
      throw failure(response.status >= 500 || response.status === 429 ? 'network' : 'unknown',
        response.status === 429 ? 'quota' : 'network', String(response.status));
    }
    return data;
  }

  function clientId(value) {
    return typeof value === 'string' && /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(value.trim())
      ? value.trim() : null;
  }

  async function authorize(interactive, codeFlow = false, oauthSecret = null, listScope = true) {
    if (!(await chrome.permissions.contains(PERMISSIONS))) throw failure('permission');
    const { gcalClientId } = await chrome.storage.local.get('gcalClientId');
    const id = clientId(gcalClientId);
    if (!id) throw failure('client');
    const state = randomString();
    const redirect = chrome.identity.getRedirectURL();
    const verifier = codeFlow ? randomString() : null;
    const challenge = verifier ? btoa(String.fromCharCode(...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
    const params = new URLSearchParams({
      client_id: id, response_type: codeFlow ? 'code' : 'token', redirect_uri: redirect,
      scope: listScope ? SCOPE_BASE + ' ' + SCOPE_LIST : SCOPE_BASE, state, include_granted_scopes: 'true', prompt: interactive ? 'consent' : 'none'
    });
    if (codeFlow) {
      params.set('access_type', 'offline');
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
    }
    const { gcalAccount } = await chrome.storage.local.get('gcalAccount');
    if (gcalAccount && !interactive && !codeFlow) params.set('login_hint', gcalAccount);
    let returned;
    try {
      returned = await chrome.identity.launchWebAuthFlow({
        url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params, interactive,
        ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 20000 })
      });
    } catch (error) {
      const message = String(error?.message || '');
      const googleCode = /\b(login_required|consent_required|interaction_required|account_selection_required)\b/.exec(message)?.[1];
      if (googleCode) throw failure('reconnect', oauthReason(googleCode), 'google-oauth');
      if (/redirect_uri_mismatch|invalid_client|unauthorized_client/i.test(message)) throw failure('client');
      if (/timed?\s*out|timeout/i.test(message)) throw failure('network', 'timeout', 'chrome-timeout');
      if (/failed to launch|could not (?:create|open).*window|window.*(?:failed|unavailable)/i.test(message))
        throw failure('network', 'chrome-window', 'chrome-window');
      if (/cancel|closed|denied/i.test(message) && interactive) throw failure('cancelled');
      throw failure(interactive ? 'network' : 'uncertain', 'unknown', 'chrome-flow');
    }
    let url;
    try { url = new URL(returned); } catch { throw failure(interactive ? 'client' : 'uncertain'); }
    if (url.origin + url.pathname !== new URL(redirect).origin + new URL(redirect).pathname) throw failure('client');
    const fragment = new URLSearchParams(url.hash.slice(1));
    const error = fragment.get('error') || url.searchParams.get('error');
    if (fragment.get('state') !== state && url.searchParams.get('state') !== state)
      throw failure(interactive ? 'client' : 'uncertain');
    if (error) throw failure(error === 'redirect_uri_mismatch' || error === 'invalid_client' ? 'client'
      : interactive && error === 'access_denied' ? 'cancelled'
        : oauthReason(error) !== 'unknown' ? 'reconnect' : 'uncertain', oauthReason(error), 'google-oauth');
    if (codeFlow) {
      const code = url.searchParams.get('code');
      if (!code) throw failure('network');
      const data = await tokenRequest({ code, client_id: id, client_secret: oauthSecret,
        code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }, true);
      if (!data.refresh_token) throw failure('network');
      await GcalSecret.set({ clientSecret: oauthSecret, refreshToken: data.refresh_token, issuedAt: Date.now() });
      return rememberToken(data.access_token, Number(data.expires_in), data.scope);
    }
    const token = fragment.get('access_token');
    const seconds = Number(fragment.get('expires_in'));
    if (!token) throw failure(interactive ? 'client' : 'uncertain');
    return rememberToken(token, seconds, fragment.get('scope'));
  }

  async function access(force = false) {
    await examSessionReady;
    const saved = (await chrome.storage.session.get('gcalAccess')).gcalAccess;
    if (!force && saved?.token && saved.exp > Date.now() + 60000) return saved.token;
    try {
      const credentials = await GcalSecret.get();
      if (credentials?.refreshToken && credentials.clientSecret) {
        const { gcalClientId } = await chrome.storage.local.get('gcalClientId');
        const data = await tokenRequest({ client_id: clientId(gcalClientId),
          client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken,
          grant_type: 'refresh_token' });
        return rememberToken(data.access_token, Number(data.expires_in), data.scope);
      }
      // A 1.8.47 connection never agreed to the list scope; asking for it silently
      // would fail with consent_required, so renew with what was granted.
      const { gcalListGranted } = await chrome.storage.local.get('gcalListGranted');
      return await authorize(false, false, null, gcalListGranted === true);
    } catch (error) {
      await chrome.storage.session.remove('gcalAccess');
      throw error;
    }
  }

  // soft: a 403 or 404 means "not ours or gone" and throws code 'denied' instead of
  // counting as a lost connection. Used while probing calendars from the list.
  async function api(path, method = 'GET', body, retry = true, soft = false) {
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
    } catch (error) { throw failure('network', error?.name === 'TimeoutError' ? 'timeout' : 'network'); }
    if (response.status === 401 && retry) {
      await access(true);
      return api(path, method, body, false, soft);
    }
    if (soft && (response.status === 403 || response.status === 404)) throw failure('denied', 'unknown', String(response.status));
    if (response.status === 401) throw failure('reconnect', 'token-revoked', '401');
    if (response.status === 403) {
      let details;
      try { details = await response.json(); } catch { /* HTTP status still identifies the failure. */ }
      const reasons = details?.error?.errors?.map(entry => entry.reason) || [];
      const quota = reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded',
        'dailyLimitExceeded'].includes(reason));
      const auth = reasons.some(reason => ['authError', 'insufficientPermissions', 'forbiddenForNonOrganizer'].includes(reason));
      throw failure(auth ? 'reconnect' : 'network', quota ? 'quota' : auth ? 'consent' : 'unknown', '403');
    }
    if (response.status === 429 || response.status >= 500) throw failure('network',
      response.status === 429 ? 'quota' : 'network', String(response.status));
    if (!response.ok) throw failure(String(response.status));
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw failure('network'); }
  }

  // Every 아캠 플러스 calendar this app can open, smallest id first. Throws on a bad
  // page so a partial list never leads to deleting anything.
  async function candidates() {
    const found = new Set();
    let pageToken = '';
    do {
      const query = new URLSearchParams({ minAccessRole: 'owner', showHidden: 'true', maxResults: '250' });
      if (pageToken) query.set('pageToken', pageToken);
      const page = await api('/users/me/calendarList?' + query);
      if (!Array.isArray(page?.items)) throw failure('network', 'unknown', 'calendar-list');
      for (const entry of page.items) {
        if (typeof entry?.id === 'string' && (entry.summary === NAME || String(entry.description || '').includes(MARK))) {
          found.add(entry.id);
        }
      }
      pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : '';
    } while (pageToken);
    const usable = [];
    // A same-named calendar the user made by hand is outside calendar.app.created.
    for (const id of [...found].sort()) {
      try { usable.push({ id, calendar: await api('/calendars/' + encodeURIComponent(id), 'GET', null, true, true) }); }
      catch (error) { if (error.code !== 'denied') throw error; }
    }
    return usable;
  }

  async function remember(id, info, reset) {
    const owner = typeof info?.dataOwner === 'string' ? info.dataOwner : null;
    await chrome.storage.local.set({ gcalCalendarId: id, ...(reset ? { gcalEvents: {} } : {}), ...(owner ? { gcalAccount: owner } : {}) });
  }

  async function create() {
    if (createAttempted) throw failure('network', 'unknown', 'calendar-create-pending');
    createAttempted = true;
    const created = await api('/calendars', 'POST', { summary: NAME, description: DESCRIPTION, timeZone: 'Asia/Seoul' });
    if (!created?.id) throw failure('network');
    await remember(created.id, created, true);
    return { id: created.id, created: true, extras: [] };
  }

  // Picks the calendar to write to. With the list scope every profile lands on the
  // same one (smallest id) and returns the rest as extras to delete after the write.
  async function calendar() {
    const saved = await chrome.storage.local.get(['gcalCalendarId', 'gcalListGranted']);
    const id = saved.gcalCalendarId;
    if (saved.gcalListGranted === true) {
      let usable = null;
      try { usable = await candidates(); }
      catch (error) {
        // Granted on paper but refused: fall back to the saved id and ask to reconnect.
        if (!(error.code === 'reconnect' && error.detail === '403')) throw error;
        await chrome.storage.local.set({ gcalListGranted: false });
      }
      if (usable) {
        if (!usable.length) return create();
        const [chosen, ...extras] = usable;
        if (!String(chosen.calendar?.description || '').includes(MARK)) {
          const description = [chosen.calendar?.description, DESCRIPTION].filter(Boolean).join('\n');
          try { await api('/calendars/' + encodeURIComponent(chosen.id), 'PATCH', { description }); }
          catch (error) { reportError('gcal', '구글 캘린더 설명 표시 실패: ' + (error.code || 'unknown')); }
        }
        await remember(chosen.id, chosen.calendar, chosen.id !== id);
        return { id: chosen.id, created: chosen.id !== id, extras: extras.map(entry => entry.id) };
      }
    }
    if (!id) return create();
    try {
      const existing = await api('/calendars/' + encodeURIComponent(id), 'GET', null, true, true);
      const owner = typeof existing?.dataOwner === 'string' ? existing.dataOwner : null;
      const old = (await chrome.storage.local.get('gcalAccount')).gcalAccount;
      if (!(owner && old && owner !== old)) {
        if (owner) await chrome.storage.local.set({ gcalAccount: owner });
        return { id, created: false, extras: [] };
      }
    } catch (error) { if (error.code !== 'denied') throw error; }
    // Without the list scope another profile may have merged this calendar away;
    // making a new one would just be merged again, so ask for the list grant instead.
    throw failure('reconnect', 'consent', 'calendar-missing');
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

  async function state(error, count, merged = 0) {
    const old = (await chrome.storage.local.get('gcalState')).gcalState || {};
    const now = Date.now();
    let problem = null;
    let reason = null;
    let uncertainCount = 0;
    let uncertainSince = null;
    if (error) {
      reason = error.reason || 'unknown';
      uncertainCount = error.code === 'uncertain' ? (old.uncertainCount || 0) + 1 : 0;
      uncertainSince = error.code === 'uncertain' ? (old.uncertainSince || now) : null;
      problem = error.code === 'reconnect' || (error.code === 'uncertain'
        && uncertainCount > 3 && now - uncertainSince >= 6 * 3600000) ? 'reconnect' : 'network';
      if (error.code === 'permission') problem = 'permission';
    }
    const next = { ...old, problem, reason, problemAt: problem ?
      old.problem === problem && old.reason === reason ? old.problemAt || now : now : null,
      uncertainCount, uncertainSince,
      ...(error ? {} : { lastSyncAt: now, count, connectError: null, connectErrorAt: null }),
      ...(merged ? { merged, mergedAt: now } : {}) };
    await chrome.storage.local.set({ gcalState: next });
    if (problem && (old.problem !== problem || old.reason !== reason))
      reportError('gcal', '구글 캘린더: ' + problem + '/' + reason + ' ' + (error.detail || ''));
    if (problem === 'reconnect' && old.problem !== 'reconnect') {
      await chrome.notifications.create('icampus-gcal-reconnect', {
        type: 'basic', iconUrl: 'icons/notify-assignment.png',
        title: '구글 캘린더 연결이 끊겼어요',
        message: '아캠 플러스 설정에서 다시 연결해 주세요'
      }).catch(notifyError => reportError('gcal', '구글 캘린더 알림 실패: ' +
        String(notifyError?.message || 'unknown'), { stack: notifyError?.stack }));
    }
    return next;
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
    let merged = 0;
    if (forceCalendar || changed || !saved.gcalCalendarId) {
      const cal = await calendar();
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
      // Only after the chosen calendar holds every event: duplicates from other profiles go.
      for (const id of cal.extras) {
        if (await examIsActive()) return { error: 'permission' };
        try { await api('/calendars/' + encodeURIComponent(id), 'DELETE', null, true, true); merged++; }
        catch (error) {
          if (error.code !== 'denied') throw error;
          reportError('gcal', '구글 캘린더: 겹친 캘린더를 지우지 못함 HTTP ' + error.detail);
        }
      }
    }
    if (full) await chrome.storage.local.set({ gcalFullAt: Date.now() });
    await state(null, wanted.size, merged);
    return { ok: true };
  }

  async function runSync(forceCalendar = false) {
    createAttempted = false;
    try { return await sync(forceCalendar); }
    catch (error) {
      const current = await state(error);
      return { error: current.problem === 'reconnect' || error.code === 'permission' ? 'permission' : 'network' };
    }
  }

  async function syncIfEnabled() {
    const { gcalEnabled } = await chrome.storage.local.get('gcalEnabled');
    if (!gcalEnabled) return;
    return serialize(() => runSync());
  }

  async function connect() {
    if (connecting) return { error: 'network' };
    connecting = true;
    connectFailureReason = 'unknown';
    connectSyncFailed = false;
    try {
      await chrome.storage.session.remove(PENDING);
      if (await examIsActive()) return { error: 'permission' };
      const saved = await chrome.storage.local.get('gcalClientId');
      if (!clientId(saved.gcalClientId)) return { error: 'client' };
      if (!(await chrome.permissions.contains(PERMISSIONS))) return { error: 'permission' };
      const credentials = await GcalSecret.get();
      await authorize(true, Boolean(credentials?.clientSecret), credentials?.clientSecret);
      const result = await runSync(true);
      connectSyncFailed = Boolean(result.error);
      if (result.ok) await chrome.storage.local.set({ gcalEnabled: true });
      if (result.ok) {
        const old = (await chrome.storage.local.get('gcalState')).gcalState || {};
        await chrome.storage.local.set({ gcalState: { ...old, connectError: null, connectErrorAt: null } });
      }
      return result;
    } catch (error) {
      connectFailureReason = error?.reason || 'unknown';
      return { error: ['cancelled', 'client', 'secret', 'permission'].includes(error.code)
        ? error.code : 'network' };
    } finally { connecting = false; }
  }

  async function saveConnectError(result) {
    if (!result?.error || result.error === 'permission') return;
    const saved = await chrome.storage.local.get('gcalState');
    const reason = connectSyncFailed ? saved.gcalState?.reason || 'unknown' : connectFailureReason;
    if (saved.gcalState?.connectError !== result.error && result.error !== 'cancelled')
      reportError('gcal', '구글 캘린더: network/' + reason +
        ' connect-' + result.error);
    await chrome.storage.local.set({ gcalState: { ...saved.gcalState,
      problem: null, problemAt: null, reason,
      connectError: result.error, connectErrorAt: Date.now() } });
  }

  async function startPending() {
    await examSessionReady;
    const pending = (await chrome.storage.session.get(PENDING))[PENDING];
    if (!pending) {
      if (lastAutoResult && Date.now() - lastAutoFinishedAt < 10000) {
        await chrome.storage.session.remove(GRANT);
        recentGrantAt = 0;
      }
      return;
    }
    if (Date.now() - pending > 3 * 60000) {
      await chrome.storage.session.remove(PENDING);
      return;
    }
    if (!(await chrome.permissions.contains(PERMISSIONS))) return;
    await chrome.storage.session.remove(GRANT);
    recentGrantAt = 0;
    const result = await connect();
    lastAutoResult = result;
    lastAutoFinishedAt = Date.now();
    await saveConnectError(result);
  }

  async function permissionAdded() {
    recentGrantAt = Date.now();
    await examSessionReady;
    await chrome.storage.session.set({ [GRANT]: recentGrantAt });
    return serialize(startPending);
  }

  async function message(type, message = {}) {
    if (type === 'icampus-gcal-status') {
      const saved = await chrome.storage.local.get(['gcalEnabled', 'gcalClientId', 'gcalState', 'gcalCalendarId', 'gcalListGranted']);
      const credentials = await GcalSecret.get();
      const state = saved.gcalState || {};
      return { enabled: saved.gcalEnabled === true, hasClientId: Boolean(clientId(saved.gcalClientId)),
        problem: state.problem || null, reason: state.reason || null, problemAt: state.problemAt || null,
        lastSyncAt: state.lastSyncAt || null, count: state.count || 0,
        calendar: Boolean(saved.gcalCalendarId), hasSecret: Boolean(credentials?.clientSecret),
        offline: Boolean(credentials?.refreshToken), hasAccount: Boolean((await chrome.storage.local.get('gcalAccount')).gcalAccount),
        connectError: Date.now() - state.connectErrorAt < 5 * 60000 ? state.connectError || null : null,
        needsListConsent: saved.gcalEnabled === true && saved.gcalListGranted !== true,
        merged: Date.now() - state.mergedAt < 24 * 3600000 ? state.merged || 0 : 0 };
    }
    return serialize(async () => {
      if (type === 'icampus-gcal-prepare') {
        await examSessionReady;
        if (await examIsActive()) return { error: 'permission' };
        lastAutoResult = null;
        const savedId = (await chrome.storage.local.get('gcalClientId')).gcalClientId;
        const id = clientId(message.clientId === undefined ? savedId : message.clientId);
        if (!id) return { error: 'client' };
        const value = message.clientSecret !== undefined && message.clientSecret !== ''
          ? secret(message.clientSecret) : undefined;
        if (value === null) return { error: 'secret' };
        if (message.clientId !== undefined) await chrome.storage.local.set({ gcalClientId: id });
        if (message.clientSecret !== undefined && message.clientSecret !== '') {
          // Merge: a cancelled reconnect must not drop the refresh token already held.
          await GcalSecret.set({ ...(await GcalSecret.get()), clientSecret: value });
        }
        await chrome.storage.session.set({ [PENDING]: Date.now() });
        const grantAt = Math.max(recentGrantAt, (await chrome.storage.session.get(GRANT))[GRANT] || 0);
        if (Date.now() - grantAt < 3 * 60000) serialize(startPending);
        return { ok: true };
      }
      if (type === 'icampus-gcal-disconnect') {
        await chrome.storage.local.set({ gcalEnabled: false });
        await examSessionReady;
        await chrome.storage.session.remove(PENDING);
        await chrome.storage.session.remove(GRANT);
        recentGrantAt = 0;
        const stored = (await chrome.storage.session.get('gcalAccess')).gcalAccess;
        const credentials = await GcalSecret.get();
        for (const token of [credentials?.refreshToken, stored?.token]) {
          if (!token) continue;
          try {
            const response = await fetch('https://oauth2.googleapis.com/revoke', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) reportError('gcal', '구글 캘린더 토큰 폐기 실패: HTTP ' + response.status);
          } catch (error) { reportError('gcal', '구글 캘린더 토큰 폐기 실패: ' +
            String(error?.name || 'network'), { stack: error?.stack }); }
        }
        await GcalSecret.clear();
        await chrome.storage.session.remove('gcalAccess');
        await chrome.storage.local.remove('gcalEvents');
        const old = (await chrome.storage.local.get('gcalState')).gcalState || {};
        await chrome.storage.local.set({ gcalState: { ...old, problem: null, reason: null,
          problemAt: null, connectError: null, uncertainCount: 0, uncertainSince: null } });
        return { ok: true };
      }
      if (type === 'icampus-gcal-connect') {
        await examSessionReady;
        await chrome.storage.session.remove(PENDING);
        if (message.clientSecret !== undefined && message.clientSecret !== '') {
          const value = secret(message.clientSecret);
          if (!value) return { error: 'secret' };
          await GcalSecret.set({ ...(await GcalSecret.get()), clientSecret: value });
          lastAutoResult = null;
        }
        if (lastAutoResult && Date.now() - lastAutoFinishedAt < 10000) return lastAutoResult;
        const result = await connect();
        await saveConnectError(result);
        return result;
      }
      if (type === 'icampus-gcal-sync') {
        if ((await chrome.storage.local.get('gcalEnabled')).gcalEnabled !== true) return { error: 'permission' };
        return runSync();
      }
      return { error: 'permission' };
    });
  }

  return { message, syncIfEnabled, permissionAdded, PERMISSIONS };
})();
