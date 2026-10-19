importScripts('exam.js', 'errlog.js');
chrome.permissions.onAdded.addListener(added => {
  if (added.permissions?.includes('nativeMessaging')) ErrorLog.flushPending();
});
self.addEventListener('error', event => {
  reportError('worker', event.message || '알 수 없는 오류', { stack: event.error?.stack });
});
self.addEventListener('unhandledrejection', event => {
  reportError('worker', String(event.reason?.message || event.reason || '처리되지 않은 오류'),
    { stack: event.reason?.stack });
});
const examSessionReady = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
// Keep the playlist in the existing iCampus tab. The worker may be suspended
// between videos, so chrome.storage.session is the source of truth.
const STATE_KEY = 'icampusPlaylistState';
// Read from the manifest so the worker and player.js cannot drift apart again.
const WORKER_VERSION = chrome.runtime.getManifest().version;
// Tabs opened from a popup title. They only get the Canvas launch-button
// help below; player.js gets no playlist key there, so no 2x or autoplay.
const DIRECT_KEY = 'icampusDirectTabs';
const DIRECT_MUTED_KEY = 'directMutedTabs';
const DIRECT_TTL_MS = 2 * 60 * 1000;
const advanceLocks = new Set();
let messageQueue = Promise.resolve();
const EXAM_TABS_KEY = 'examTabs';
let examQueue = Promise.resolve();

function queueExam(task) {
  const next = examQueue.then(async () => {
    await examSessionReady;
    return task();
  });
  examQueue = next.catch(() => {});
  return next;
}

async function examTabs() {
  const saved = await chrome.storage.session.get(EXAM_TABS_KEY);
  return Array.isArray(saved[EXAM_TABS_KEY]) ? saved[EXAM_TABS_KEY] : [];
}

async function updateExamTab(tabId, url) {
  const before = await examTabs();
  const after = before.filter(id => id !== tabId);
  if (ExamMode.EXAM_URL.test(url || '')) after.push(tabId);
  if (after.length === before.length && after.every(id => before.includes(id))) return;
  await chrome.storage.session.set({ [EXAM_TABS_KEY]: after });
  await notifyExamState();
  const { examGuard, examModeManual } = await chrome.storage.local.get(['examGuard', 'examModeManual']);
  if (!before.length && after.length && examGuard !== false) await ExamMode.enterExamMode('auto');
  if (before.length && !after.length && examModeManual !== true) await ExamMode.exitExamMode();
}

async function reconcileExamTabs() {
  const tabs = await chrome.tabs.query({});
  const found = tabs.filter(tab => ExamMode.EXAM_URL.test(tab.url || '')).map(tab => tab.id);
  const before = await examTabs();
  await chrome.storage.session.set({ [EXAM_TABS_KEY]: found });
  await notifyExamState();
  const { examGuard, examModeManual, examNotificationsBlocked } = await chrome.storage.local.get([
    'examGuard', 'examModeManual', 'examNotificationsBlocked'
  ]);
  const disabledIds = await ExamMode.disabledIds();
  if (found.length && examGuard !== false && !before.length) await ExamMode.enterExamMode('auto');
  if (!found.length && examModeManual !== true &&
      (disabledIds.length || examNotificationsBlocked === true)) {
    await ExamMode.exitExamMode();
  }
}

async function examStatus() {
  const [tabs, saved, session, hasManagementPermission, hasContentSettingsPermission] = await Promise.all([
    examTabs(),
    chrome.storage.local.get(['examGuard', 'examModeManual', 'examDisabledIds', 'examRestorePending', 'examRestoreManual', 'examRestoreManualIds', 'examDisableFailures', 'examNotificationsBlocked', 'examFullscreen']),
    chrome.storage.session.get(['examDisabledIds', 'examRestoreManualIds', 'examBlockedCount']),
    chrome.permissions.contains({ permissions: ['management'] }),
    chrome.permissions.contains({ permissions: ['contentSettings'] })
  ]);
  const ids = Object.hasOwn(session, 'examDisabledIds') ? session.examDisabledIds : saved.examDisabledIds;
  const count = Array.isArray(ids) ? ids.length : 0;
  const manualIds = Object.hasOwn(session, 'examRestoreManualIds')
    ? session.examRestoreManualIds : saved.examRestoreManualIds;
  const manualCount = Array.isArray(manualIds) ? manualIds.length : 0;
  return {
    guard: saved.examGuard !== false,
    manual: saved.examModeManual === true,
    examTabs: tabs.length,
    disabledCount: saved.examRestorePending ? 0 : count,
    pendingRestore: saved.examRestorePending ? count + manualCount : 0,
    restoreNeedsApproval: saved.examRestoreManual === true,
    disableFailures: saved.examDisableFailures || 0,
    blockedCount: session.examBlockedCount || 0,
    notificationsBlocked: saved.examNotificationsBlocked === true && hasContentSettingsPermission,
    notificationRestorePending: saved.examNotificationsBlocked === true && !hasContentSettingsPermission,
    fullscreen: saved.examFullscreen !== false,
    hasManagementPermission,
    hasContentSettingsPermission,
    hasPermission: hasManagementPermission && hasContentSettingsPermission
  };
}

async function examIsActive() {
  const saved = await chrome.storage.local.get(['examGuard', 'examModeManual']);
  return saved.examGuard !== false &&
    (saved.examModeManual === true || (await examTabs()).length > 0);
}

async function notifyExamState() {
  const [tabs, saved] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(['examGuard', 'examModeManual'])
  ]);
  const blocked = saved.examGuard !== false &&
    (saved.examModeManual === true || (await examTabs()).length > 0);
  if (blocked) {
    const task = messageQueue.then(async () => {
      await stopPlaylist();
      await releaseAllDirectMutes();
    });
    messageQueue = task.catch(() => {});
    await task;
  }
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'icampus-exam-blocked', blocked }).catch(() => {});
  }
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url === undefined && change.status !== 'complete') return;
  queueExam(() => updateExamTab(tabId, change.url || tab.url)).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  queueExam(() => updateExamTab(tabId, null)).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { queueExam(reconcileExamTabs).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { queueExam(reconcileExamTabs).catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.examGuard || changes.examModeManual)) {
    queueExam(notifyExamState).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  (async () => {
    const saved = await chrome.storage.local.get(['screenMode', 'darkMode', 'icampusTheme']);
    if (!['auto', 'light', 'dark'].includes(saved.screenMode)) {
      // 1.5.x의 darkMode/icampusTheme는 팝업 색만 정하던 값이다. 화면 모드는 아이캠퍼스 페이지 전체에 걸리므로 '어둡게'만 옮기고 '밝게'는 자동으로 둔다
      const old = saved.darkMode === true || saved.icampusTheme === 'dark' ? 'dark' : null;
      if (old) await chrome.storage.local.set({ screenMode: old });
    }
    await chrome.storage.local.remove(['darkMode', 'icampusTheme']);
  })().catch(() => {});
});

// 확장이 설치·업데이트·다시 로드되거나 웨일이 시작할 때, 이미 열려 있는 아이캠퍼스 탭에는 콘텐츠 스크립트가 들어가지 않는다(새로고침 전까지).
// 다크 모드가 켜져 있는데 그 탭만 밝게 남지 않도록 manifest와 같은 순서로 CSS와 스크립트를 넣는다. 이미 들어간 프레임(ICDColor가 있는 프레임)은 건너뛴다.
// 권한은 기존 scripting과 canvas.skku.edu 호스트 권한만 쓴다. 로그인 화면(/xn-sso/)은 manifest와 같이 제외한다.
const DARK_CSS = ['dark/sheets.css', 'dark/instui.css', 'dark/dark.css', 'dark/adapt.css'];
const DARK_JS = ['dark/color.js', 'dark/transform.js', 'dark/boot.js', 'dark/exam-guard.js', 'dark/styles.js', 'dark/adapt.js'];

async function injectDarkIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://canvas.skku.edu/*' });
  for (const tab of tabs) {
    if (!tab.id || tab.discarded || !tab.url || new URL(tab.url).pathname.startsWith('/xn-sso/')) continue;
    try {
      const probe = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => !!globalThis.ICDColor });
      const frameIds = probe.filter(r => r.result === false).map(r => r.frameId);
      if (!frameIds.length) continue;
      await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds }, files: DARK_CSS });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds }, files: DARK_JS });
    } catch (e) {
      /* 접근할 수 없는 프레임이나 닫힌 탭은 건너뛴다. 새로고침하면 manifest 주입이 한다 */
    }
  }
}
chrome.runtime.onInstalled.addListener(() => { injectDarkIntoOpenTabs(); });
chrome.runtime.onStartup.addListener(() => { injectDarkIntoOpenTabs(); });

function canvasUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://canvas.skku.edu' ? url.href : null;
  } catch { return null; }
}

async function getState() {
  const saved = await chrome.storage.session.get(STATE_KEY);
  return saved[STATE_KEY] || null;
}

// Keep a lecture tab out of Whale's automatic tab sleep while the extension plays it.
// Tab ids are kept in session storage so a restarted worker can still release them.
const AWAKE_KEY = 'awakeLectureTabs';
async function keepTabAwake(tabId, awake) {
  try { await chrome.tabs.update(tabId, { autoDiscardable: !awake }); }
  catch { /* The tab may already be closed. */ }
  const saved = (await chrome.storage.session.get(AWAKE_KEY))[AWAKE_KEY] || {};
  if (awake) saved[tabId] = true; else delete saved[tabId];
  await chrome.storage.session.set({ [AWAKE_KEY]: saved });
}

async function saveState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: { ...state, updatedAt: Date.now() } });
  if (state.status === 'error') reportError('worker', String(state.error || '재생목록 오류'));
  if (['finished', 'stopped', 'error'].includes(state.status)) await keepTabAwake(state.tabId, false);
  if (['finished', 'stopped', 'error'].includes(state.status) && state.tabMutedBefore === false) {
    try { await chrome.tabs.update(state.tabId, { muted: false }); }
    catch (error) { reportError('worker', '재생목록 탭 음소거를 되돌리지 못했습니다.', { stack: error?.stack }); }
  }
}

function canvasLectureUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://canvas.skku.edu' &&
      /^\/courses\/\d+\/(?:modules\/items|external_tools)\/\d+(?:\/|$)/.test(parsed.pathname);
  } catch { return false; }
}

async function releaseDirectMute(tabId, closed = false) {
  const saved = await chrome.storage.session.get(DIRECT_MUTED_KEY);
  const tabs = saved[DIRECT_MUTED_KEY] || {};
  if (!tabs[tabId]) return;
  if (!closed) {
    try { await chrome.tabs.update(tabId, { muted: false }); }
    catch { return; }
  }
  delete tabs[tabId];
  await chrome.storage.session.set({ [DIRECT_MUTED_KEY]: tabs });
}

async function releaseAllDirectMutes() {
  const saved = await chrome.storage.session.get(DIRECT_MUTED_KEY);
  for (const tabId of Object.keys(saved[DIRECT_MUTED_KEY] || {})) {
    await releaseDirectMute(Number(tabId));
  }
}

async function setDirectMute(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id ||
      typeof message.muted !== 'boolean') return null;
  try { if (new URL(sender.url).origin !== 'https://lcms.skku.edu') return null; }
  catch { return null; }
  if (await examIsActive()) return null;
  const state = await getState();
  if (state?.tabId === sender.tab.id && !['finished', 'stopped', 'error'].includes(state.status)) return null;
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!canvasLectureUrl(tab.url)) return null;
  const saved = await chrome.storage.session.get(DIRECT_MUTED_KEY);
  const owned = saved[DIRECT_MUTED_KEY] || {};
  if (message.muted) {
    if (!tab.mutedInfo?.muted) {
      await chrome.tabs.update(tab.id, { muted: true });
      owned[tab.id] = true;
      await chrome.storage.session.set({ [DIRECT_MUTED_KEY]: owned });
    }
  } else if (owned[tab.id]) {
    await releaseDirectMute(tab.id);
  }
  const current = await chrome.tabs.get(tab.id);
  return { muted: current.mutedInfo?.muted === true };
}

function validSender(sender, state) {
  if (!state || sender.tab?.id !== state.tabId) return false;
  try { return new URL(sender.url).origin === 'https://lcms.skku.edu'; }
  catch { return false; }
}

async function startPlaylist(message) {
  if (await examIsActive()) throw new Error('시험 중에는 연속 재생을 시작할 수 없어요.');
  const tab = await chrome.tabs.get(message.tabId);
  if (new URL(tab.url).origin !== 'https://canvas.skku.edu') throw new Error('아이캠퍼스 탭에서 시작해 주세요.');
  const queue = Array.isArray(message.queue) ? message.queue.filter(item =>
    typeof item.key === 'string' && canvasUrl(item.url)) : [];
  if (!queue.length || queue.length > 100) throw new Error('재생할 아이캠퍼스 강의를 찾지 못했습니다.');
  await stopPlaylist();
  await releaseDirectMute(tab.id);
  const lectureTab = await chrome.tabs.get(tab.id);
  const state = { tabId: tab.id, tabMutedBefore: lectureTab.mutedInfo?.muted,
    queue, index: 0, status: 'opening', currentTime: 0, duration: 0, rate: 1, soundBlocked: false };
  await saveState(state);
  try {
    await chrome.tabs.update(tab.id, { muted: true });
    await keepTabAwake(tab.id, true);
    if (tab.url === queue[0].url) await chrome.tabs.reload(tab.id);
    else await chrome.tabs.update(tab.id, { url: queue[0].url });
    chrome.tabs.sendMessage(tab.id, { type: 'icampus-playlist-probe' }).catch(() => {});
  } catch (error) {
    await saveState({ ...state, status: 'error', error: error.message });
    throw error;
  }
  return { ok: true };
}

async function openLecture(message) {
  if (await examIsActive()) throw new Error('시험 중에는 강의를 열 수 없어요.');
  const url = canvasUrl(message.url);
  if (!url) throw new Error('아이캠퍼스 주소가 아닙니다.');
  const options = { url, active: message.active !== false };
  if (Number.isInteger(message.openerTabId)) options.openerTabId = message.openerTabId;
  let tab;
  try { tab = await chrome.tabs.create(options); }
  catch { tab = await chrome.tabs.create({ url, active: options.active }); }
  try {
    const saved = await chrome.storage.session.get(DIRECT_KEY);
    await chrome.storage.session.set({ [DIRECT_KEY]: { ...(saved[DIRECT_KEY] || {}), [tab.id]: Date.now() } });
  } catch { /* The tab is open; only the launch-button help is skipped. */ }
  return { ok: true };
}

async function takeDirectTab(tabId) {
  const saved = await chrome.storage.session.get(DIRECT_KEY);
  const tabs = saved[DIRECT_KEY];
  if (!tabs) return false;
  const found = Date.now() - (tabs[tabId] || 0) < DIRECT_TTL_MS;
  const kept = Object.fromEntries(Object.entries(tabs).filter(([id, time]) =>
    Number(id) !== tabId && Date.now() - time < DIRECT_TTL_MS));
  if (Object.keys(kept).length) await chrome.storage.session.set({ [DIRECT_KEY]: kept });
  else await chrome.storage.session.remove(DIRECT_KEY);
  return found;
}

async function handlePlayerMessage(message, sender) {
  if (await examIsActive()) { await stopPlaylist(); return null; }
  const state = await getState();
  if (!validSender(sender, state) || !['opening', 'connecting', 'playing', 'paused', 'blocked', 'ended-unconfirmed'].includes(state.status)) {
    if (message.type !== 'icampus-player-ready' || sender.id !== chrome.runtime.id || !sender.tab?.id) return null;
    try { if (new URL(sender.url).origin !== 'https://lcms.skku.edu') return null; }
    catch { return null; }
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!canvasLectureUrl(tab.url)) return null;
    await keepTabAwake(tab.id, true);
    return { direct: true, muted: tab.mutedInfo?.muted === true };
  }
  const current = state.queue[state.index];
  if (!current) return null;
  if (message.type === 'icampus-player-ready') {
    if (message.playerVersion !== WORKER_VERSION) {
      // Reload the lecture tab once per lecture; a second mismatch stops here
      // instead of reloading forever.
      if (state.playerReloadedFor === current.key) {
        await saveState({ ...state, status: 'error',
          error: '강의 화면이 이전 버전으로 남아 있어요. 웨일을 다시 시작한 뒤 재생해 주세요.' });
        return null;
      }
      await saveState({ ...state, status: 'opening', error: null, playerReloadedFor: current.key });
      await chrome.tabs.reload(state.tabId);
      return null;
    }
    if (state.status === 'ended-unconfirmed') return null;
    await saveState({ ...state, status: 'connecting' });
    return { start: true, key: current.key, rate: 2 };
  }
  if (message.key !== current.key) return null;
  if (message.type === 'icampus-player-progress') {
    if (state.status === 'ended-unconfirmed') return null;
    await saveState({ ...state,
      status: message.paused ? 'paused' : 'playing',
      currentTime: Number.isFinite(message.currentTime) ? message.currentTime : 0,
      duration: Number.isFinite(message.duration) ? message.duration : 0,
      rate: Number.isFinite(message.rate) ? message.rate : 1
    });
    return { ok: true };
  }
  if (message.type === 'icampus-player-state') {
    if (message.state === 'autoplay-blocked') await saveState({ ...state, status: 'blocked' });
    else if (message.state === 'ended-unconfirmed') await saveState({ ...state, status: 'ended-unconfirmed' });
    else if (message.state === 'speed-unavailable') await saveState({ ...state, speedUnavailable: true });
    else if (message.state === 'speed-2x') await saveState({ ...state, rate: 2, speedUnavailable: false });
    else if (message.state === 'muted-fallback') await saveState({ ...state, soundBlocked: true });
    else if (message.state === 'sound-on') await saveState({ ...state, soundBlocked: false });
    return { ok: true };
  }
  if (message.type === 'icampus-player-ended') {
    if (advanceLocks.has(state.tabId)) return { ok: true };
    advanceLocks.add(state.tabId);
    try {
      const nextIndex = state.index + 1;
      if (nextIndex >= state.queue.length) {
        await saveState({ ...state, index: nextIndex, status: 'finished' });
      } else {
        const next = { ...state, index: nextIndex, status: 'opening', currentTime: 0, duration: 0, rate: 1,
          soundBlocked: false };
        await saveState(next);
        try { await chrome.tabs.update(state.tabId, { url: next.queue[nextIndex].url }); }
        catch (error) { await saveState({ ...next, status: 'error', error: error.message }); }
      }
    } finally { advanceLocks.delete(state.tabId); }
    return { ok: true };
  }
  return null;
}

async function stopPlaylist() {
  const state = await getState();
  if (!state || ['finished', 'stopped'].includes(state.status)) return { ok: true };
  await saveState({ ...state, status: 'stopped' });
  try { await chrome.tabs.sendMessage(state.tabId, { type: 'icampus-playlist-stop' }); }
  catch { /* The lecture frame may already be gone. */ }
  await chrome.storage.session.remove(STATE_KEY);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['icampus-playlist-start', 'icampus-playlist-stop', 'icampus-open-lecture',
    'icampus-player-ready', 'icampus-player-progress', 'icampus-player-state',
    'icampus-player-ended', 'icampus-direct-mute', 'exam-status', 'exam-start', 'exam-stop', 'exam-restore',
    'icampus-exam-blocked-count', 'icampus-error-log'].includes(message.type)) return;
  // Only extension pages (the popup) may start a playlist or open a lecture.
  const extensionPage = sender.id === chrome.runtime.id &&
    sender.url?.startsWith(chrome.runtime.getURL(''));
  if (['icampus-playlist-start', 'icampus-playlist-stop', 'icampus-open-lecture',
       'exam-start', 'exam-stop', 'exam-restore'].includes(message.type) &&
      !extensionPage) return;
  if (message.type === 'exam-status' && !extensionPage &&
      !['https://lcms.skku.edu', 'https://kingoinfo.skku.edu'].some(origin => sender.url?.startsWith(origin + '/'))) return;
  if (message.type === 'icampus-error-log') {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith('https://lcms.skku.edu/')) return;
    const task = (async () => {
      if (await examIsActive() || ExamMode.EXAM_URL.test(sender.tab?.url || '')) return;
      if (typeof message.source !== 'string' || typeof message.message !== 'string') return;
      return reportError(message.source, message.message, {
        url: sender.url, stack: typeof message.stack === 'string' ? message.stack : undefined
      });
    })();
    task.then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'icampus-exam-blocked-count') {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id) return;
    const task = queueExam(async () => {
      const url = sender.tab.url || '';
      const saved = await chrome.storage.local.get(['examGuard', 'examModeManual']);
      if (saved.examGuard === false || !(ExamMode.EXAM_URL.test(url) ||
          (saved.examModeManual === true && url.startsWith('https://canvas.skku.edu/')))) return;
      const state = await chrome.storage.session.get('examBlockedCount');
      await chrome.storage.session.set({ examBlockedCount: (state.examBlockedCount || 0) + 1 });
    });
    task.then(() => sendResponse({ ok: true }), error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type.startsWith('exam-')) {
    const task = queueExam(async () => {
      if (message.type === 'exam-start') {
        await chrome.storage.local.set({ examModeManual: true });
        await ExamMode.enterExamMode('manual');
      } else if (message.type === 'exam-stop') {
        await chrome.storage.local.set({ examModeManual: false });
        if (!(await examTabs()).length) await ExamMode.exitExamMode();
      } else if (message.type === 'exam-restore') {
        await ExamMode.exitExamMode({ manualRestore: true });
      }
      return examStatus();
    });
    task.then(sendResponse, error => sendResponse({ error: error.message }));
    return true;
  }
  const task = messageQueue.then(() => message.type === 'icampus-playlist-start' ? startPlaylist(message)
    : message.type === 'icampus-playlist-stop' ? stopPlaylist()
    : message.type === 'icampus-open-lecture' ? openLecture(message)
    : message.type === 'icampus-direct-mute' ? setDirectMute(message, sender)
    : handlePlayerMessage(message, sender));
  messageQueue = task.catch(() => {});
  task.then(result => sendResponse(result), error => sendResponse({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  const task = messageQueue.then(async () => {
    const state = await getState();
    if (state?.tabId === tabId) await chrome.storage.session.remove(STATE_KEY);
    await releaseDirectMute(tabId, true);
  });
  messageQueue = task.catch(() => {});
  return task;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url || canvasLectureUrl(change.url)) return;
  const task = messageQueue.then(async () => {
    await releaseDirectMute(tabId);
    const state = await getState();
    const playlistTab = state?.tabId === tabId && !['finished', 'stopped', 'error'].includes(state.status);
    const awake = (await chrome.storage.session.get(AWAKE_KEY))[AWAKE_KEY] || {};
    if (awake[tabId] && !playlistTab) await keepTabAwake(tabId, false);
  });
  messageQueue = task.catch(() => {});
});

async function autoLaunchCanvasTool(waitMs = 0) {
  // Some Canvas module items show an LTI launch button instead of loading
  // the lecture immediately. Submit only the official lecture launch form.
  const launch = () => {
    if (!document.documentElement.hasAttribute('data-icd')) return false;
    const form = document.querySelector('form#tool_form');
    const button = document.querySelector('.load_tool_button');
    if (!form || !button || !button.getClientRects().length) return false;
    let action;
    try { action = new URL(form.action, location.href); } catch { return false; }
    if (!['https://canvas.skku.edu', 'https://lcms.skku.edu'].includes(action.origin)) return false;
    form.target = '_self';
    HTMLFormElement.prototype.submit.call(form);
    return true;
  };
  // A title-click tab gets one visit, so wait briefly for a late-rendered button.
  const deadline = Date.now() + waitMs;
  while (!launch()) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return true;
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete' || !tab.url?.startsWith('https://canvas.skku.edu/')) return;
  const task = messageQueue.then(async () => {
    const state = await getState();
    if (state?.tabId === tabId && state.status === 'opening') return 'playlist';
    // One launch visit per title click; later navigation in that tab is the user's.
    return await takeDirectTab(tabId) ? 'direct' : null;
  });
  messageQueue = task.catch(() => {});
  // Run outside the queue so a short wait for the button never delays player messages.
  task.then(async kind => {
    if (!kind) return;
    if (await examIsActive()) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, func: autoLaunchCanvasTool, args: [kind === 'direct' ? 5000 : 0]
      });
      if (kind === 'playlist') chrome.tabs.sendMessage(tabId, { type: 'icampus-playlist-probe' }).catch(() => {});
    } catch { /* The tab may have moved to its lecture frame already. */ }
  }).catch(() => {});
});
