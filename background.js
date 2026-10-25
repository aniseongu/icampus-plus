importScripts('exam.js', 'errlog.js', 'executescript.js', 'secrets.js', 'gcal.js', 'notify.js');
chrome.permissions.onAdded.addListener(added => {
  if (added.permissions?.includes('nativeMessaging')) ErrorLog.flushPending();
  if (added.permissions?.includes('identity') ||
      added.origins?.some(origin => Gcal.PERMISSIONS.origins.includes(origin))) {
    Gcal.permissionAdded().catch(error => reportError('gcal', '구글 캘린더 권한 처리 실패: ' +
      String(error?.message || 'unknown'), { stack: error?.stack }));
  }
});
self.addEventListener('error', event => {
  reportError('worker', event.message || '알 수 없는 오류', { stack: event.error?.stack });
});
self.addEventListener('unhandledrejection', event => {
  reportError('worker', String(event.reason?.message || event.reason || '처리되지 않은 오류'),
    { stack: event.reason?.stack });
});
const examSessionReady = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
function logWorker(description, error, source = 'worker') {
  const message = String(error?.message || error || '알 수 없는 오류');
  // Closed tabs, absent frames and invalidated extension contexts are expected races.
  if (/No tab with id|Frame with ID|Extension context invalidated|Receiving end does not exist/i.test(message)) return;
  reportError(source, description + ': ' + message, { stack: error?.stack });
}
// Keep the playlist in the existing iCampus tab. The worker may be suspended
// between videos, so chrome.storage.session is the source of truth.
const STATE_KEY = 'icampusPlaylistState';
// Read from the manifest so the worker and player.js cannot drift apart again.
const WORKER_VERSION = chrome.runtime.getManifest().version;
// Tabs opened from a popup title. They only get the Canvas launch-button
// help below; player.js gets no playlist key there, so no 2x or autoplay.
const DIRECT_KEY = 'icampusDirectTabs';
const DIRECT_MUTED_KEY = 'directMutedTabs';
const PLAYLIST_MUTED_KEY = 'playlistMutedTabs';
const DEFAULTS_DIRTY_KEY = 'playerDefaultsDirty';
const AWAKE_KEY = 'awakeLectureTabs';
const DIRECT_TTL_MS = 2 * 60 * 1000;
const advanceLocks = new Set();
// The playlist tab is not playing in these states: no mute or sleep exemption is
// held. 'halted' is a user pause (정지) that keeps the queue for 재생.
const INACTIVE_STATUSES = ['finished', 'stopped', 'error', 'halted'];
let messageQueue = Promise.resolve();
const EXAM_TABS_KEY = 'examTabs';
let examQueue = Promise.resolve();

function queueExam(task) {
  const next = examQueue.then(async () => {
    await examSessionReady;
    return task();
  });
  examQueue = next.catch(() => {}); // Callers report the failed exam task.
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
      const awake = (await chrome.storage.local.get(AWAKE_KEY))[AWAKE_KEY] || {};
      for (const tabId of Object.keys(awake)) await keepTabAwake(Number(tabId), false);
    });
    messageQueue = task.catch(error => logWorker('시험 상태 정리 실패', error));
    await task;
  }
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'icampus-exam-blocked', blocked })
      .catch(error => logWorker('시험 상태 전달 실패', error));
  }
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url === undefined && change.status !== 'complete') return;
  queueExam(() => updateExamTab(tabId, change.url || tab.url)).catch(error => logWorker('시험 탭 갱신 실패', error));
});
chrome.tabs.onRemoved.addListener(tabId => {
  queueExam(() => updateExamTab(tabId, null)).catch(error => logWorker('시험 탭 제거 실패', error));
});
chrome.runtime.onStartup.addListener(() => { queueExam(reconcileExamTabs).catch(error => logWorker('시험 탭 복원 실패', error)); });
chrome.runtime.onInstalled.addListener(() => { queueExam(reconcileExamTabs).catch(error => logWorker('시험 탭 초기화 실패', error)); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.examGuard || changes.examModeManual)) {
    queueExam(notifyExamState).catch(error => logWorker('시험 상태 알림 실패', error));
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
  })().catch(error => logWorker('설정 마이그레이션 실패', error));
});

// 확장이 설치·업데이트·다시 로드되거나 웨일이 시작할 때, 이미 열려 있는 아이캠퍼스 탭에는 콘텐츠 스크립트가 들어가지 않는다(새로고침 전까지).
// 다크 모드가 켜져 있는데 그 탭만 밝게 남지 않도록 manifest와 같은 순서로 CSS와 스크립트를 넣는다. 이미 들어간 프레임(ICDColor가 있는 프레임)은 건너뛴다.
// 권한은 기존 scripting과 manifest 주입 범위(canvas.skku.edu, 로그인 화면)만 쓴다. 웨일이 시작할 때 복원된 탭은 확장보다 먼저 열릴 수 있다.
const DARK_CSS = ['dark/sheets.css', 'dark/instui.css', 'dark/dark.css', 'dark/adapt.css'];
const DARK_JS = ['dark/color.js', 'dark/transform.js', 'dark/boot.js', 'dark/exam-guard.js', 'dark/styles.js', 'dark/adapt.js'];

// 로그인 화면(/xn-sso/)은 manifest와 같이 dark.css와 boot.js만 넣는다(D-012). 입력값은 건드리지 않는다.
const LOGIN_DARK_CSS = ['dark/dark.css'];
const LOGIN_DARK_JS = ['dark/boot.js'];

async function injectDarkIntoLoginTab(tab) {
  const probe = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true },
    func: () => document.documentElement.hasAttribute('data-icd-login') });
  const frameIds = probe.filter(r => r.result === false).map(r => r.frameId);
  if (!frameIds.length) return;
  await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds }, files: LOGIN_DARK_CSS });
  await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds }, files: LOGIN_DARK_JS });
}

async function injectDarkIntoOpenTabs() {
  // icampus.skku.edu는 로그인 화면만 호스트 권한이 있다(1.8.11, 사용자 승인 2026-10-19).
  const tabs = await chrome.tabs.query({ url: ['https://canvas.skku.edu/*', 'https://icampus.skku.edu/xn-sso/*'] });
  for (const tab of tabs) {
    if (!tab.id || tab.discarded || !tab.url) continue;
    if (new URL(tab.url).pathname.startsWith('/xn-sso/')) {
      try { await injectDarkIntoLoginTab(tab); } catch (e) { logWorker('로그인 다크 모드 주입 실패', e, 'dark'); }
      continue;
    }
    try {
      const probe = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => !!globalThis.ICDColor });
      const frameIds = probe.filter(r => r.result === false).map(r => r.frameId);
      if (!frameIds.length) continue;
      await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds }, files: DARK_CSS });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds }, files: DARK_JS });
    } catch (e) {
      logWorker('다크 모드 주입 실패', e, 'dark');
    }
  }
}
chrome.runtime.onInstalled.addListener(() => { injectDarkIntoOpenTabs().catch(error => logWorker('열린 탭 다크 모드 주입 실패', error, 'dark')); });
chrome.runtime.onStartup.addListener(() => { injectDarkIntoOpenTabs().catch(error => logWorker('시작 시 다크 모드 주입 실패', error, 'dark')); });

function canvasUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://canvas.skku.edu' ? url.href : null;
  } catch { /* Invalid external URLs are rejected by validation. */ return null; }
}

async function getState() {
  const saved = await chrome.storage.session.get(STATE_KEY);
  const state = saved[STATE_KEY] || null;
  // Before 1.8.11 the queue kept played lectures and index pointed at the current one.
  if (state && Number.isInteger(state.index) && state.index > 0 && Array.isArray(state.queue)) {
    return { ...state, queue: state.queue.slice(state.index), index: 0 };
  }
  return state;
}

// Keep a lecture tab out of Whale's automatic tab sleep while the extension plays it.
// Ownership survives an extension reload; playlist progress itself stays in session.
async function keepTabAwake(tabId, awake) {
  const saved = (await chrome.storage.local.get(AWAKE_KEY))[AWAKE_KEY] || {};
  if (awake) saved[tabId] = true; else delete saved[tabId];
  await chrome.storage.local.set({ [AWAKE_KEY]: saved });
  try { await chrome.tabs.update(tabId, { autoDiscardable: !awake }); }
  catch (error) { logWorker('탭 절전 설정 실패', error); }
}

async function releasePlaylistMute(tabId) {
  const owned = (await chrome.storage.local.get(PLAYLIST_MUTED_KEY))[PLAYLIST_MUTED_KEY] || {};
  if (!owned[tabId]) return;
  try { await chrome.tabs.update(tabId, { muted: false }); }
  catch (error) { logWorker('재생목록 탭 음소거 해제 실패', error); }
  delete owned[tabId];
  await chrome.storage.local.set({ [PLAYLIST_MUTED_KEY]: owned });
}

async function saveState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: { ...state, updatedAt: Date.now() } });
  if (state.status === 'error') reportError('worker', String(state.error || '재생목록 오류'));
  if (INACTIVE_STATUSES.includes(state.status)) await keepTabAwake(state.tabId, false);
  if (INACTIVE_STATUSES.includes(state.status)) await releasePlaylistMute(state.tabId);
}

function canvasLectureUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://canvas.skku.edu' &&
      /^\/courses\/\d+\/(?:modules\/items|external_tools)\/\d+(?:\/|$)/.test(parsed.pathname);
  } catch { /* Invalid lecture URLs are rejected by validation. */ return false; }
}

async function releaseDirectMute(tabId, closed = false) {
  const saved = await chrome.storage.local.get(DIRECT_MUTED_KEY);
  const tabs = saved[DIRECT_MUTED_KEY] || {};
  if (!tabs[tabId]) return;
  if (!closed) {
    try { await chrome.tabs.update(tabId, { muted: false }); }
    catch (error) { logWorker('직접 재생 탭 음소거 해제 실패', error); }
  }
  delete tabs[tabId];
  await chrome.storage.local.set({ [DIRECT_MUTED_KEY]: tabs });
}

async function releaseAllDirectMutes() {
  const saved = await chrome.storage.local.get(DIRECT_MUTED_KEY);
  for (const tabId of Object.keys(saved[DIRECT_MUTED_KEY] || {})) {
    await releaseDirectMute(Number(tabId));
  }
}

async function reconcileOwnedTabs(startup = false) {
  const keys = [DIRECT_MUTED_KEY, AWAKE_KEY, PLAYLIST_MUTED_KEY];
  const [local, legacy] = await Promise.all([
    chrome.storage.local.get(keys), chrome.storage.session.get([DIRECT_MUTED_KEY, AWAKE_KEY])
  ]);
  const owned = Object.fromEntries(keys.map(key => [key, { ...(legacy[key] || {}), ...(local[key] || {}) }]));
  await chrome.storage.session.remove([DIRECT_MUTED_KEY, AWAKE_KEY]);
  if (startup) {
    await chrome.storage.local.remove(keys);
    return; // Browser restart may reuse tab ids for different tabs.
  }
  const state = await getState();
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const playlistActive = state && !INACTIVE_STATUSES.includes(state.status) &&
    canvasLectureUrl(byId.get(state.tabId)?.url);
  if (playlistActive && state.tabMutedBefore === false) owned[PLAYLIST_MUTED_KEY][state.tabId] = true;
  const ids = new Set(keys.flatMap(key => Object.keys(owned[key])));
  for (const id of ids) {
    const tab = byId.get(Number(id));
    const playlist = playlistActive && state.tabId === Number(id);
    const directPlaying = !playlist && tab && canvasLectureUrl(tab.url) && tab.audible === true;
    // Only lecture tabs: after a browser restart a reused id may belong to another tab.
    if (tab && canvasLectureUrl(tab.url) && !playlist && !directPlaying) {
      if (owned[DIRECT_MUTED_KEY][id] || owned[PLAYLIST_MUTED_KEY][id]) {
        try { await chrome.tabs.update(tab.id, { muted: false }); }
        catch (error) { logWorker('탭 음소거 복원 실패', error); }
      }
      if (owned[AWAKE_KEY][id]) {
        try { await chrome.tabs.update(tab.id, { autoDiscardable: true }); }
        catch (error) { logWorker('탭 절전 복원 실패', error); }
      }
    }
    // A lecture still playing after a reload keeps our mute; hand it to the direct
    // record so leaving the lecture later still unmutes the tab.
    if (directPlaying && owned[PLAYLIST_MUTED_KEY][id]) owned[DIRECT_MUTED_KEY][id] = true;
    if (!directPlaying) delete owned[DIRECT_MUTED_KEY][id];
    if (!playlist) delete owned[PLAYLIST_MUTED_KEY][id];
    if (!playlist && !directPlaying) delete owned[AWAKE_KEY][id];
  }
  await chrome.storage.local.set(owned);
}

async function setDirectMute(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id ||
      typeof message.muted !== 'boolean') return null;
  try { if (new URL(sender.url).origin !== 'https://lcms.skku.edu') return null; }
  catch { return null; }
  if (await examIsActive()) return null;
  const state = await getState();
  if (state?.tabId === sender.tab.id && !INACTIVE_STATUSES.includes(state.status)) return null;
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!canvasLectureUrl(tab.url)) return null;
  const saved = await chrome.storage.local.get(DIRECT_MUTED_KEY);
  const owned = saved[DIRECT_MUTED_KEY] || {};
  if (message.muted) {
    if (!tab.mutedInfo?.muted) {
      owned[tab.id] = true;
      await chrome.storage.local.set({ [DIRECT_MUTED_KEY]: owned });
      await chrome.tabs.update(tab.id, { muted: true });
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

// The queue holds only the lectures still to play; queue[0] is the current one.
// A lecture leaves the queue when it ends, and the state is removed when the
// queue is empty, so a finished playlist does not linger in the popup.
async function claimPlaylistTab(state) {
  if (state.tabMutedBefore === false) {
    const owned = (await chrome.storage.local.get(PLAYLIST_MUTED_KEY))[PLAYLIST_MUTED_KEY] || {};
    owned[state.tabId] = true;
    await chrome.storage.local.set({ [PLAYLIST_MUTED_KEY]: owned });
  }
  await chrome.tabs.update(state.tabId, { muted: true });
  await keepTabAwake(state.tabId, true);
}

async function openQueueHead(state, claim = false) {
  const next = { ...state, status: 'opening', error: null, currentTime: 0, duration: 0, rate: 1,
    soundBlocked: false, speedUnavailable: false, playerReloadedFor: null };
  await saveState(next);
  try {
    if (claim) await claimPlaylistTab(next);
    const tab = await chrome.tabs.get(next.tabId);
    if (tab.url === next.queue[0].url) await chrome.tabs.reload(next.tabId);
    else await chrome.tabs.update(next.tabId, { url: next.queue[0].url });
    chrome.tabs.sendMessage(next.tabId, { type: 'icampus-playlist-probe' })
      .catch(error => logWorker('재생목록 확인 실패', error));
  } catch (error) {
    await saveState({ ...next, status: 'error', error: error.message });
    throw error;
  }
}

async function finishPlaylist(state) {
  // saveState releases the tab's mute and sleep exemption before the state goes.
  await saveState({ ...state, queue: [], status: 'finished' });
  await chrome.storage.session.remove(STATE_KEY);
}

function queueItem(item) {
  if (!item || typeof item.key !== 'string' || !canvasUrl(item.url)) return null;
  const text = value => typeof value === 'string' ? value.slice(0, 300) : '';
  const due = typeof item.due === 'string' && Number.isFinite(Date.parse(item.due)) ? item.due : null;
  return { key: item.key, course: text(item.course), title: text(item.title), url: canvasUrl(item.url), due };
}

async function startPlaylist(message) {
  if (await examIsActive()) throw new Error('시험 중에는 재생 목록을 시작할 수 없어요.');
  const queue = Array.isArray(message.queue) ? message.queue.map(queueItem).filter(Boolean) : [];
  if (!queue.length || queue.length > 100) throw new Error('재생할 아이캠퍼스 강의를 찾지 못했습니다.');
  // Lectures picked while a playlist exists join its end; the current lecture keeps playing.
  const state = message.append ? await getState() : null;
  if (state?.queue?.length) {
    const known = new Set(state.queue.map(item => item.key));
    const merged = [...state.queue, ...queue.filter(item => !known.has(item.key))];
    if (merged.length > 100) throw new Error('재생 목록에는 100개까지 넣을 수 있어요.');
    await saveState({ ...state, queue: merged });
    return { ok: true };
  }
  const tab = await chrome.tabs.get(message.tabId);
  if (new URL(tab.url).origin !== 'https://canvas.skku.edu') throw new Error('아이캠퍼스 탭에서 시작해 주세요.');
  await stopPlaylist();
  await releaseDirectMute(tab.id);
  const lectureTab = await chrome.tabs.get(tab.id);
  await openQueueHead({ tabId: tab.id, tabMutedBefore: lectureTab.mutedInfo?.muted, queue }, true);
  return { ok: true };
}

// The popup sends the order the user chose. A new first lecture plays right away;
// the one it replaces keeps its place second and resumes later.
async function reorderPlaylist(message) {
  if (await examIsActive()) throw new Error('시험 중에는 재생 목록을 바꿀 수 없어요.');
  const state = await getState();
  if (!state?.queue?.length) throw new Error('재생 목록이 없어요.');
  const byKey = new Map(state.queue.map(item => [item.key, item]));
  const keys = Array.isArray(message.keys) ? message.keys : [];
  if (keys.length !== byKey.size || new Set(keys).size !== keys.length || !keys.every(key => byKey.has(key))) {
    throw new Error('재생 목록이 그사이 바뀌었어요. 다시 시도해 주세요.');
  }
  const queue = keys.map(key => byKey.get(key));
  const idle = ['error', 'halted'].includes(state.status);
  if (queue[0].key === state.queue[0].key && !idle) {
    await saveState({ ...state, queue });
  } else {
    await openQueueHead({ ...state, queue }, idle);
  }
  return { ok: true };
}

async function removePlaylistItem(message) {
  if (await examIsActive()) throw new Error('시험 중에는 재생 목록을 바꿀 수 없어요.');
  const state = await getState();
  const index = state?.queue?.findIndex(item => item.key === message.key) ?? -1;
  if (index < 0) throw new Error('재생 목록이 그사이 바뀌었어요. 다시 시도해 주세요.');
  const queue = state.queue.filter((_, itemIndex) => itemIndex !== index);
  if (!queue.length) await stopPlaylist();
  else if (index > 0 || ['error', 'halted'].includes(state.status)) {
    await saveState({ ...state, queue });
  } else {
    await openQueueHead({ ...state, queue });
  }
  return { ok: true };
}

// The popup rescans lectures each time it opens. Lectures the scan already shows
// as complete leave the queue. The current one leaves only when the player could
// not confirm its end, so a lecture still playing is never cut off.
async function syncPlaylist(message) {
  if (await examIsActive()) return { ok: true };
  const state = await getState();
  if (!state?.queue?.length || !Array.isArray(message.doneKeys)) return { ok: true };
  const done = new Set(message.doneKeys.filter(key => typeof key === 'string'));
  const [head, ...others] = state.queue;
  const rest = others.filter(item => !done.has(item.key));
  // A paused list only drops finished lectures; it never starts playing by itself.
  if (state.status === 'halted') {
    const queue = done.has(head.key) ? rest : [head, ...rest];
    if (!queue.length) await finishPlaylist(state);
    else if (queue.length !== state.queue.length) await saveState({ ...state, queue });
  } else if (done.has(head.key) && ['ended-unconfirmed', 'error'].includes(state.status)) {
    if (!rest.length) await finishPlaylist(state);
    else await openQueueHead({ ...state, queue: rest }, state.status === 'error');
  } else if (rest.length !== others.length) {
    await saveState({ ...state, queue: [head, ...rest] });
  }
  return { ok: true };
}

// 영상 저장 (D-019): the lecture frame sends the files the player lists; only
// https vod.skku.edu mp4 addresses are saved, into Downloads/아캠 플러스/.
// vod.skku.edu answers with an error page unless the request names the lecture
// player as its referrer. The static rule dnr/vod-referer.json sets it for
// requests to vod.skku.edu once the optional permissions are granted. (A session
// rule set from code stayed pending right after the grant until a restart, and
// chrome.runtime.reload() then left the unpacked extension blocked; 2026-10-20.)
// declarativeNetRequestWithHostAccess is a required permission (the static rule
// needs it; it shows no warning and acts only on hosts the extension may access),
// so 영상 저장 asks only for downloads and vod.skku.edu.
const VIDEO_SAVE_PERMISSIONS = { permissions: ['downloads'], origins: ['https://vod.skku.edu/*'] };
const VIDEO_STREAM_PATH = '/video-download';

function vodUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'vod.skku.edu' && url.pathname.endsWith('.mp4') ? url.href : null;
  } catch { return null; }
}

// The download manager's own request bypasses the referer rule. As in
// StreamSaver.js, a background tab navigates to this worker instead: the
// worker's fetch gets the rule, the attachment header turns the navigation into
// a download (Chrome closes the tab), and the body streams to disk, so the file
// is never held in memory.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== VIDEO_STREAM_PATH) return;
  event.respondWith((async () => {
    const source = vodUrl(url.searchParams.get('src'));
    if (!source) return new Response('', { status: 400 });
    let upstream;
    try { upstream = await fetch(source, { credentials: 'include' }); }
    catch (error) { logWorker('영상 다운로드 연결 실패', error); return new Response('', { status: 502 }); }
    if (!upstream.ok || !/^video\//.test(upstream.headers.get('content-type') || '')) {
      reportError('worker', '영상 다운로드 응답 실패: HTTP ' + upstream.status);
      return new Response('', { status: 502 });
    }
    const name = (url.searchParams.get('name') || '강의') + '.mp4';
    const headers = new Headers({ 'Content-Type': 'video/mp4',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name) });
    const length = upstream.headers.get('content-length');
    if (length) headers.set('Content-Length', length);
    // Keep the worker busy with a cheap API call while the file streams, so it
    // is not stopped as idle in the middle of a long lecture.
    const reader = upstream.body.getReader();
    const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo()
      .catch(error => logWorker('영상 다운로드 워커 유지 실패', error)); }, 20000);
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { clearInterval(keepAlive); controller.close(); } else controller.enqueue(value);
        } catch (error) { clearInterval(keepAlive); logWorker('영상 스트림 읽기 실패', error); controller.error(error); }
      },
      cancel(reason) { clearInterval(keepAlive); return reader.cancel(reason); }
    });
    return new Response(body, { headers });
  })());
});

// Downloads/아캠 플러스/<title>.mp4, the starter tab closed, and a notice if the
// download breaks off. The downloads API exists only once the optional
// permission is granted, so this runs at worker start and again when it is.
function videoStreamUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === self.location.origin && url.pathname === VIDEO_STREAM_PATH ? url : null;
  } catch { return null; }
}

let videoDownloadWatch = false;
function watchVideoDownloads() {
  if (videoDownloadWatch || !chrome.downloads?.onDeterminingFilename) return;
  videoDownloadWatch = true;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const url = videoStreamUrl(item.url);
    if (!url) return;
    suggest({ filename: '아캠 플러스/' + (url.searchParams.get('name') || '강의') + '.mp4', conflictAction: 'uniquify' });
    // Each save has its own id in the address, so this closes only its own tab.
    chrome.tabs.query({}).then(tabs => tabs.filter(tab => (tab.url || tab.pendingUrl) === item.url)
      .forEach(tab => chrome.tabs.remove(tab.id).catch(error => logWorker('영상 저장 탭 닫기 실패', error))))
      .catch(error => logWorker('영상 저장 탭 조회 실패', error));
  });
  chrome.downloads.onChanged.addListener(async delta => {
    if (delta.state?.current !== 'interrupted' || delta.error?.current === 'USER_CANCELED') return;
    const [item] = await chrome.downloads.search({ id: delta.id })
      .catch(error => { logWorker('영상 다운로드 상태 조회 실패', error); return []; });
    const url = item && videoStreamUrl(item.url);
    if (!url || item.error === 'USER_CANCELED') return;
    chrome.notifications?.create('icampus-video-' + delta.id, {
      type: 'basic', iconUrl: 'icons/notify-lecture.png', title: '영상 다운로드가 끊겼어요',
      message: url.searchParams.get('name') || '강의', contextMessage: '강의 화면에서 다시 눌러 주세요', priority: 1
    }).catch(error => logWorker('영상 다운로드 알림 실패', error));
  });
}
watchVideoDownloads();
chrome.permissions.onAdded.addListener(added => {
  if (added.permissions?.includes('downloads')) watchVideoDownloads();
});

// Lecture titles are often internal codes (SP03-7-S01-09), so name the file after
// the iCampus breadcrumb: course (before its first "_"), module, title, e.g.
// "시스템프로그램 8주차 SP03-7-S01-09".
async function lectureName(tabId) {
  try {
    const [read] = await chrome.scripting.executeScript({ target: { tabId }, func: () =>
      [...document.querySelectorAll('#breadcrumbs li')].map(item => item.textContent.trim()).filter(Boolean) });
    const crumbs = Array.isArray(read?.result) ? read.result : [];
    if (crumbs.length < 3) return null;
    const course = crumbs[1].split('_')[0].trim();
    const module = crumbs.length >= 5 ? crumbs[crumbs.length - 2] : '';
    return [course, module, crumbs[crumbs.length - 1]].filter(Boolean).join(' ');
  } catch (error) { logWorker('강의 이름 조회 실패', error); return null; }
}

async function saveLectureVideo(message, sender) {
  if (await examIsActive()) return { error: '시험 중에는 저장할 수 없어요.' };
  if (!(await chrome.permissions.contains(VIDEO_SAVE_PERMISSIONS))) return { error: 'permission' };
  const labels = ['강의', '화면', '카메라'];
  const media = (Array.isArray(message.media) ? message.media : []).filter(item => vodUrl(item?.url)).slice(0, 2);
  if (!media.length) return { error: 'no-media' };
  const raw = await lectureName(sender.tab.id) ||
    (typeof message.title === 'string' && message.title.trim() ? message.title : sender.tab?.title || '강의');
  // Windows forbids \ / : * ? " < > | in names; keep it short and without trailing dots.
  const name = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '') || '강의';
  watchVideoDownloads();
  for (const item of media) {
    // "제목.mp4" for one file, "제목 (화면).mp4" and "제목 (카메라).mp4" for two.
    const file = name + (labels.includes(item.label) && item.label !== '강의' ? ' (' + item.label + ')' : '');
    await chrome.tabs.create({ active: false, url: chrome.runtime.getURL(VIDEO_STREAM_PATH.slice(1)) +
      '?src=' + encodeURIComponent(vodUrl(item.url)) + '&name=' + encodeURIComponent(file) +
      '&id=' + crypto.randomUUID() });
  }
  return { ok: true, count: media.length };
}

async function openLecture(message) {
  if (await examIsActive()) throw new Error('시험 중에는 강의를 열 수 없어요.');
  const url = canvasUrl(message.url);
  if (!url) throw new Error('아이캠퍼스 주소가 아닙니다.');
  const options = { url, active: message.active !== false };
  if (Number.isInteger(message.openerTabId)) options.openerTabId = message.openerTabId;
  let tab;
  try { tab = await chrome.tabs.create(options); }
  catch (error) { logWorker('강의 탭 열기 옵션 실패', error); tab = await chrome.tabs.create({ url, active: options.active }); }
  try {
    const saved = await chrome.storage.session.get(DIRECT_KEY);
    await chrome.storage.session.set({ [DIRECT_KEY]: { ...(saved[DIRECT_KEY] || {}), [tab.id]: Date.now() } });
  } catch (error) { logWorker('강의 탭 연결 기록 실패', error); }
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
    const defaults = await chrome.storage.local.get(DEFAULTS_DIRTY_KEY);
    return { direct: true, muted: tab.mutedInfo?.muted === true,
      resetDefaults: defaults[DEFAULTS_DIRTY_KEY] === true };
  }
  const current = state.queue?.[0];
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
      const rest = state.queue.slice(1);
      if (!rest.length) await finishPlaylist(state);
      else await openQueueHead({ ...state, queue: rest }).catch(() => {}); // saveState already recorded the failure.
    } finally { advanceLocks.delete(state.tabId); }
    return { ok: true };
  }
  return null;
}

// 정지: pause the current lecture and keep the list. 재생 on any row resumes.
async function haltPlaylist() {
  const state = await getState();
  if (!state?.queue?.length || INACTIVE_STATUSES.includes(state.status)) return { ok: true };
  await saveState({ ...state, status: 'halted' });
  try { await chrome.tabs.sendMessage(state.tabId, { type: 'icampus-playlist-stop' }); }
  catch { /* The lecture frame may already be gone. */ }
  return { ok: true };
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
  if (!message || !['icampus-playlist-start', 'icampus-playlist-stop', 'icampus-playlist-reorder', 'icampus-playlist-remove',
    'icampus-playlist-sync', 'icampus-playlist-halt', 'icampus-schedule',
    'icampus-video-save-status', 'icampus-video-save', 'icampus-open-lecture', 'icampus-player-ready', 'icampus-player-progress', 'icampus-player-state',
    'icampus-player-ended', 'icampus-direct-mute', 'exam-status', 'exam-start', 'exam-stop', 'exam-restore',
    'icampus-exam-blocked-count', 'icampus-error-log', 'icampus-canvas-token-status',
    'icampus-canvas-token-set', 'icampus-canvas-token-clear',
    'icampus-gcal-status', 'icampus-gcal-prepare', 'icampus-gcal-connect', 'icampus-gcal-disconnect', 'icampus-gcal-sync'].includes(message.type)) return;
  const settingsPage = sender.id === chrome.runtime.id &&
    [chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('options.html')].includes(sender.url);
  if (message.type.startsWith('icampus-gcal-')) {
    if (!settingsPage) return;
    Gcal.message(message.type, message).then(sendResponse, error => {
      reportError('gcal', '구글 캘린더 메시지 실패: ' + String(error?.message || 'unknown'),
        { stack: error?.stack });
      sendResponse({ error: 'network' });
    });
    return true;
  }
  if (message.type.startsWith('icampus-canvas-token-')) {
    if (!settingsPage) return;
    const task = message.type === 'icampus-canvas-token-status'
      ? Promise.all([CanvasToken.status(), chrome.permissions.contains({ permissions: ['cookies'] })])
        .then(([status, lectures]) => ({ ...status, lectures })) :
      (message.type === 'icampus-canvas-token-set' ? CanvasToken.save(message.token) : CanvasToken.clear())
        .then(status => {
          queueNotify(async () => {
            try { await backgroundScan(); await checkNotifications(); }
            catch (error) { logWorker('토큰 저장 후 일정 조회 실패', error, 'notify'); }
          });
          return status;
        });
    task.then(sendResponse, error => {
      if (!['invalid-format', 'rejected', 'other-account'].includes(error?.code))
        logWorker('Canvas 토큰 메시지 실패', error);
      sendResponse({ error: error?.code || 'network' });
    });
    return true;
  }
  // Only extension pages (the popup) may start a playlist or open a lecture.
  const extensionPage = sender.id === chrome.runtime.id &&
    sender.url?.startsWith(chrome.runtime.getURL(''));
  if (['icampus-playlist-start', 'icampus-playlist-stop', 'icampus-playlist-reorder', 'icampus-playlist-remove', 'icampus-playlist-sync',
       'icampus-playlist-halt', 'icampus-schedule', 'icampus-open-lecture', 'exam-start', 'exam-stop', 'exam-restore'].includes(message.type) &&
      !extensionPage) return;
  if (message.type === 'exam-status' && !extensionPage &&
      !['https://lcms.skku.edu', 'https://kingoinfo.skku.edu'].some(origin => sender.url?.startsWith(origin + '/'))) return;
  if (message.type.startsWith('icampus-video-')) {
    // The lecture player frame only.
    if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.url?.startsWith('https://lcms.skku.edu/')) return;
    const task = message.type === 'icampus-video-save' ? saveLectureVideo(message, sender)
      : chrome.permissions.contains(VIDEO_SAVE_PERMISSIONS).then(enabled => ({ enabled }));
    task.then(sendResponse, error => { logWorker('영상 저장 메시지 실패', error); sendResponse({ error: error.message }); });
    return true;
  }
  if (message.type === 'icampus-error-log') {
    if (sender.id !== chrome.runtime.id || !(settingsPage || [
      'https://lcms.skku.edu/', 'https://canvas.skku.edu/', 'https://kingoinfo.skku.edu/',
      'https://icampus.skku.edu/xn-sso/'
    ].some(prefix => sender.url?.startsWith(prefix)))) return;
    const task = (async () => {
      if (await examIsActive() || ExamMode.EXAM_URL.test(sender.tab?.url || '')) return;
      if (typeof message.source !== 'string' || typeof message.message !== 'string') return;
      return reportError(message.source, message.message, {
        url: sender.url, stack: typeof message.stack === 'string' ? message.stack : undefined
      });
    })();
    // The error recorder cannot report its own failure without recursion.
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
    task.then(sendResponse, error => { logWorker('시험 메시지 실패', error, 'exam'); sendResponse({ error: error.message }); });
    return true;
  }
  const task = messageQueue.then(() => message.type === 'icampus-playlist-start' ? startPlaylist(message)
    : message.type === 'icampus-playlist-stop' ? stopPlaylist()
    : message.type === 'icampus-playlist-reorder' ? reorderPlaylist(message)
    : message.type === 'icampus-playlist-remove' ? removePlaylistItem(message)
    : message.type === 'icampus-playlist-sync' ? syncPlaylist(message)
    : message.type === 'icampus-playlist-halt' ? haltPlaylist()
    : message.type === 'icampus-schedule'
      ? queueNotify(async () => {
        await updateSchedule(message.result);
        if (message.result && !message.result.fatal && Array.isArray(message.result.items)) await Gcal.syncIfEnabled();
        if (message.result && !message.result.fatal && Array.isArray(message.result.items)) {
          await updateActivity(message.result);
          await recordScanSuccess({ usedToken: false, rejected: false });
        }
        await checkNotifications();
        return { ok: true };
      })
    : message.type === 'icampus-open-lecture' ? openLecture(message)
    : message.type === 'icampus-direct-mute' ? setDirectMute(message, sender)
    : handlePlayerMessage(message, sender));
  messageQueue = task.catch(() => {}); // The response handler below records task failure.
  task.then(result => sendResponse(result), error => {
    logWorker('메시지 처리 실패', error);
    sendResponse({ error: error.message });
  });
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  const task = messageQueue.then(async () => {
    const state = await getState();
    if (state?.tabId === tabId) await chrome.storage.session.remove(STATE_KEY);
    await releaseDirectMute(tabId, true);
    await releasePlaylistMute(tabId);
    await keepTabAwake(tabId, false);
  });
  messageQueue = task.catch(error => logWorker('닫힌 탭 정리 실패', error));
  return task;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url || canvasLectureUrl(change.url)) return;
  const task = messageQueue.then(async () => {
    await releaseDirectMute(tabId);
    const state = await getState();
    const playlistTab = state?.tabId === tabId && !INACTIVE_STATUSES.includes(state.status);
    const awake = (await chrome.storage.local.get(AWAKE_KEY))[AWAKE_KEY] || {};
    if (awake[tabId] && !playlistTab) await keepTabAwake(tabId, false);
  });
  messageQueue = task.catch(error => logWorker('탭 이동 정리 실패', error));
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
  messageQueue = task.catch(error => logWorker('강의 도구 주입 준비 실패', error));
  // Run outside the queue so a short wait for the button never delays player messages.
  task.then(async kind => {
    if (!kind) return;
    if (await examIsActive()) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, func: autoLaunchCanvasTool, args: [kind === 'direct' ? 5000 : 0]
      });
      if (kind === 'playlist') chrome.tabs.sendMessage(tabId, { type: 'icampus-playlist-probe' })
        .catch(error => logWorker('재생목록 확인 실패', error));
    } catch (error) { logWorker('강의 도구 주입 실패', error); }
  }).catch(error => logWorker('강의 도구 처리 실패', error));
});

let startupOwnershipCleanup = false;
function queueOwnershipCleanup(startup = false) {
  if (startup) startupOwnershipCleanup = true;
  const task = messageQueue.then(() => reconcileOwnedTabs(startup));
  messageQueue = task.catch(error => logWorker('재생 탭 소유권 정리 실패', error));
}
chrome.runtime.onInstalled.addListener(() => queueOwnershipCleanup());
chrome.runtime.onStartup.addListener(() => queueOwnershipCleanup(true));
// Give onStartup a chance to mark browser restart before the ordinary reload pass.
setTimeout(() => { if (!startupOwnershipCleanup) queueOwnershipCleanup(); }, 0);
