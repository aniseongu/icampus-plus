// Keep the playlist in the existing iCampus tab. The worker may be suspended
// between videos, so chrome.storage.session is the source of truth.
const STATE_KEY = 'icampusPlaylistState';
const WORKER_VERSION = '1.5.18';
// Tabs opened from a popup title. They only get the Canvas launch-button
// help below; player.js gets no playlist key there, so no 2x or autoplay.
const DIRECT_KEY = 'icampusDirectTabs';
const DIRECT_TTL_MS = 2 * 60 * 1000;
const advanceLocks = new Set();
let messageQueue = Promise.resolve();

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
const DARK_JS = ['dark/color.js', 'dark/transform.js', 'dark/boot.js', 'dark/styles.js', 'dark/adapt.js'];

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

async function saveState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: { ...state, updatedAt: Date.now() } });
}

function validSender(sender, state) {
  if (!state || sender.tab?.id !== state.tabId) return false;
  try { return new URL(sender.url).origin === 'https://lcms.skku.edu'; }
  catch { return false; }
}

async function startPlaylist(message) {
  const tab = await chrome.tabs.get(message.tabId);
  if (new URL(tab.url).origin !== 'https://canvas.skku.edu') throw new Error('아이캠퍼스 탭에서 시작해 주세요.');
  const queue = Array.isArray(message.queue) ? message.queue.filter(item =>
    typeof item.key === 'string' && canvasUrl(item.url)) : [];
  if (!queue.length || queue.length > 100) throw new Error('재생할 아이캠퍼스 강의를 찾지 못했습니다.');
  await stopPlaylist();
  const state = { tabId: tab.id, queue, index: 0, status: 'opening', currentTime: 0, duration: 0, rate: 1 };
  await saveState(state);
  try {
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
  const state = await getState();
  if (!validSender(sender, state) || !['opening', 'connecting', 'playing', 'paused', 'blocked', 'ended-unconfirmed'].includes(state.status)) return null;
  const current = state.queue[state.index];
  if (!current) return null;
  if (message.type === 'icampus-player-ready') {
    if (message.playerVersion !== WORKER_VERSION) {
      await saveState({ ...state, status: 'opening', error: null });
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
        const next = { ...state, index: nextIndex, status: 'opening', currentTime: 0, duration: 0, rate: 1 };
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
    'icampus-player-ended'].includes(message.type)) return;
  // Only extension pages (the popup) may start a playlist or open a lecture.
  if (['icampus-playlist-start', 'icampus-playlist-stop', 'icampus-open-lecture'].includes(message.type) &&
      !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const task = messageQueue.then(() => message.type === 'icampus-playlist-start' ? startPlaylist(message)
    : message.type === 'icampus-playlist-stop' ? stopPlaylist()
    : message.type === 'icampus-open-lecture' ? openLecture(message)
    : handlePlayerMessage(message, sender));
  messageQueue = task.catch(() => {});
  task.then(result => sendResponse(result), error => sendResponse({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  const task = messageQueue.then(async () => {
    const state = await getState();
    if (state?.tabId === tabId) await chrome.storage.session.remove(STATE_KEY);
  });
  messageQueue = task.catch(() => {});
  return task;
});

async function autoLaunchCanvasTool(waitMs = 0) {
  // Some Canvas module items show an LTI launch button instead of loading
  // the lecture immediately. Submit only the official lecture launch form.
  const launch = () => {
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
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, func: autoLaunchCanvasTool, args: [kind === 'direct' ? 5000 : 0]
      });
      if (kind === 'playlist') chrome.tabs.sendMessage(tabId, { type: 'icampus-playlist-probe' }).catch(() => {});
    } catch { /* The tab may have moved to its lecture frame already. */ }
  }).catch(() => {});
});
