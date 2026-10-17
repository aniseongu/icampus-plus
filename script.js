// The original popup layout is kept; this script renders the favorite-only scan
// into its lecture and assignment tables without inserting API text as HTML.
const CANVAS_ORIGIN = 'https://canvas.skku.edu';
const BUILD_VERSION = '1.6.2';
let activeTab = null;
let loading = false;
// 화면 모드는 팝업과 아이캠퍼스 페이지(dark/boot.js)가 같이 쓴다: 'auto'(브라우저 설정) | 'light' | 'dark'
let screenMode = 'auto';
const colorMedia = matchMedia('(prefers-color-scheme: dark)');
let lastResult = null;
let selectingLectures = false;
const selectedLectureKeys = new Set();

function darkMode() {
  return screenMode === 'dark' || (screenMode === 'auto' && colorMedia.matches);
}

function applyTheme() {
  document.body.classList.toggle('dark-mode', darkMode());
  document.documentElement.style.colorScheme = darkMode() ? 'only dark' : 'only light';
  const tooltip = document.querySelector('#theme-toggle .tooltip');
  if (tooltip) tooltip.textContent = darkMode() ? '밝게 보기' : '어둡게 보기';
  for (const option of document.querySelectorAll('#screen-mode [data-mode]')) {
    option.setAttribute('aria-checked', String(option.dataset.mode === screenMode));
  }
}

function setScreenMode(mode) {
  screenMode = mode;
  applyTheme();
  chrome.storage.local.set({ screenMode: mode }).catch(() => {});
}

function element(tag, className, textValue) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== undefined) node.textContent = textValue;
  return node;
}

function showLoading() {
  document.querySelector('#completed').hidden = true;
  document.querySelector('#lecture').replaceChildren();
  const loadingBox = element('div', 'loading');
  loadingBox.append(
    element('h2', '', '즐겨찾기 과목을 확인하는 중입니다...'),
    element('div', 'spinner')
  );
  const status = element('div', 'connection-status');
  status.append(element('span', 'status-dot connecting'), element('span', '', '강의와 과제를 불러오는 중...'));
  loadingBox.append(status);
  document.querySelector('#assignment').replaceChildren(loadingBox);
  document.querySelector('#sync-status').replaceChildren();
}

function showError(message) {
  document.querySelector('#completed').hidden = true;
  document.querySelector('#lecture').replaceChildren();
  document.querySelector('#assignment').replaceChildren(element('div', 'error-message', message));
}

function safeUrl(value) {
  try {
    const url = new URL(value, CANVAS_ORIGIN);
    return url.origin === CANVAS_ORIGIN ? url.href : CANVAS_ORIGIN;
  } catch { return CANVAS_ORIGIN; }
}

function displayDate(value) {
  return value ? dateToLocaleString(value) : '기한 없음';
}

function remainingTime(value, cell) {
  if (!value) return '기한 없음';
  const remaining = Date.parse(value) - Date.now();
  if (remaining < 0) {
    cell.classList.add('urgent');
    return '마감 지남';
  }
  const urgency = getUrgencyClass(remaining);
  if (urgency) cell.classList.add(urgency);
  return msToTime(remaining);
}

// Ctrl/Cmd/middle click opens in the background so the popup stays open.
async function openItem(item, background = false) {
  const url = safeUrl(item.url);
  const openerTabId = Number.isInteger(activeTab?.id) ? activeTab.id : undefined;
  if (item.type === '강의') {
    // The worker opens the tab so it can press Canvas's launch button once.
    // That tab is not part of the playlist: no 2x or autoplay there.
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'icampus-open-lecture', url, active: !background, openerTabId
      });
      if (response?.ok) return;
    } catch { /* Fall back to a plain tab. */ }
  }
  chrome.tabs.create({ url, active: !background, ...(openerTabId ? { openerTabId } : {}) }).catch(() => {});
}

function makeTitleLink(node, item) {
  const name = replaceUnderbar(item.title);
  node.tabIndex = 0;
  node.title = name;
  node.setAttribute('role', 'link');
  node.setAttribute('aria-label', name + ', 새 탭에서 열기');
  node.addEventListener('click', event => {
    event.stopPropagation();
    openItem(item, event.ctrlKey || event.metaKey);
  });
  node.addEventListener('auxclick', event => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openItem(item, true);
  });
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openItem(item, event.ctrlKey || event.metaKey);
    }
  });
}

function createTable(items, captionText, type) {
  if (!items.length) return element('div', 'empty-message', '완료할 ' + captionText + '가 없습니다');
  const table = element('table', type);
  const caption = element('caption', '', captionText + ' ');
  const badge = element('span', 'badge', String(items.length));
  badge.id = type + '-count';
  caption.append(badge);
  table.append(caption);
  const head = element('thead');
  const headerRow = element('tr');
  ['과목', '제목', '마감기한', '남은시간'].forEach((label, index) => {
    headerRow.append(element('th', 'colum' + (index + 1), label));
  });
  head.append(headerRow);
  table.append(head);
  const body = element('tbody');
  items.forEach(item => {
    const row = element('tr');
    row.append(element('td', '', replaceUnderbar(item.course)));
    const title = element('td', 'title');
    if (type === 'lecture' && selectingLectures) {
      // The checkbox selects; the title still opens the lecture. A click
      // anywhere else on the row also selects, for a larger target.
      const choice = element('div', 'lecture-choice');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = selectedLectureKeys.has(item.key);
      check.setAttribute('aria-label', replaceUnderbar(item.title) + ' 선택');
      row.classList.add('selectable-lecture');
      row.classList.toggle('selected-lecture', check.checked);
      check.addEventListener('change', () => {
        if (check.checked) selectedLectureKeys.add(item.key);
        else selectedLectureKeys.delete(item.key);
        row.classList.toggle('selected-lecture', check.checked);
        updatePlaylistSelection();
      });
      row.addEventListener('click', event => {
        if (event.target === check) return;
        check.click();
      });
      const link = element('span', 'title-link', replaceUnderbar(item.title));
      makeTitleLink(link, item);
      choice.append(check, link);
      title.append(choice);
    } else {
      title.textContent = replaceUnderbar(item.title);
      makeTitleLink(title, item);
    }
    row.append(title);
    row.append(element('td', '', displayDate(item.due)));
    const timeCell = element('td');
    timeCell.textContent = remainingTime(item.due, timeCell);
    row.append(timeCell);
    body.append(row);
  });
  table.append(body);
  return table;
}

function playlistToolbar() {
  const toolbar = element('div', 'playlist-toolbar');
  const button = (label, className, handler) => {
    const control = element('button', 'playlist-action ' + className, label);
    control.type = 'button';
    control.addEventListener('click', handler);
    toolbar.append(control);
    return control;
  };
  if (selectingLectures) {
    const count = element('span', 'playlist-toolbar-label');
    count.id = 'playlist-selected-count';
    toolbar.append(count);
    const all = button('전체 선택', 'playlist-secondary', () => {
      const checks = [...document.querySelectorAll('table.lecture input[type="checkbox"]')];
      const target = !checks.every(check => check.checked);
      checks.forEach(check => {
        if (check.checked !== target) { check.checked = target; check.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    });
    all.id = 'playlist-select-all';
    button('취소', 'playlist-secondary', () => {
      selectingLectures = false;
      selectedLectureKeys.clear();
      persistPlaylistSelection();
      render(lastResult);
    });
    const play = button('', 'playlist-primary', startPlaylist);
    play.id = 'playlist-start';
    queueMicrotask(updatePlaylistSelection);
  } else {
    toolbar.append(element('span', 'playlist-toolbar-label', '강의 재생목록'));
    button('＋ 재생목록 만들기', 'playlist-primary', () => {
      selectingLectures = true;
      selectedLectureKeys.clear();
      persistPlaylistSelection();
      render(lastResult);
    });
  }
  return toolbar;
}

function persistPlaylistSelection() {
  chrome.storage.local.set({ icampusPlaylistDraft: { selecting: selectingLectures, keys: [...selectedLectureKeys] } }).catch(() => {});
}

function updatePlaylistSelection() {
  persistPlaylistSelection();
  const size = selectedLectureKeys.size;
  const count = document.querySelector('#playlist-selected-count');
  const play = document.querySelector('#playlist-start');
  const all = document.querySelector('#playlist-select-all');
  const checks = [...document.querySelectorAll('table.lecture input[type="checkbox"]')];
  if (count) count.textContent = size ? size + '개 선택' : '재생할 강의를 고르세요';
  if (all) all.textContent = checks.length && checks.every(check => check.checked) ? '전체 해제' : '전체 선택';
  if (play && !play.dataset.busy) {
    play.disabled = size === 0;
    play.textContent = size ? '▶ ' + size + '개 강의 재생' : '▶ 선택한 강의 재생';
  }
}

function formatPlaybackTime(value) {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function playlistStatusText(state) {
  if (state.status === 'opening') return '아이캠퍼스에서 강의를 여는 중...';
  if (state.status === 'connecting') return '학교 영상 플레이어에 연결하는 중...';
  if (state.status === 'blocked') return '자동 재생에 실패했습니다. 잠시 후 다시 확인해 주세요.';
  if (state.status === 'ended-unconfirmed') return '영상이 끝났지만 학교의 완료 표시를 확인하지 못했습니다.';
  if (state.status === 'finished') return '재생목록이 끝났습니다. 출석 상태를 아이캠퍼스에서 확인해 주세요.';
  if (state.status === 'stopped') return '연속 재생을 중지했습니다.';
  if (state.status === 'error') return '강의를 열지 못했습니다: ' + (state.error || '알 수 없는 오류');
  const progress = formatPlaybackTime(state.currentTime) +
    (state.duration > 0 ? ' / ' + formatPlaybackTime(state.duration) : '');
  const rate = state.rate > 0 ? ' · ' + Number(state.rate).toFixed(1) + '배속' : '';
  return (state.status === 'playing' ? '재생 중 · ' : '일시정지 · ') + progress + rate;
}

function renderPlaylistStatus(state) {
  const container = document.querySelector('#playlist-status');
  container.replaceChildren();
  if (!state?.queue?.length) { container.hidden = true; return; }
  container.hidden = false;
  const current = state.queue[Math.min(state.index, state.queue.length - 1)];
  const table = element('table', 'playlist-status-table');
  const caption = element('caption', '', '연속 재생 ');
  caption.append(element('span', 'badge', Math.min(state.index + 1, state.queue.length) + ' / ' + state.queue.length));
  const body = element('tbody');
  const lectureRow = element('tr');
  lectureRow.append(element('td', 'title', replaceUnderbar(current.course) + ' · ' + replaceUnderbar(current.title)));
  const stateRow = element('tr');
  stateRow.append(element('td', 'playlist-state', playlistStatusText(state)));
  body.append(lectureRow, stateRow);
  table.append(caption, body);
  container.append(table);
  if (!['finished', 'stopped', 'error'].includes(state.status)) {
    const toolbar = element('div', 'playlist-toolbar');
    const stop = element('button', 'playlist-action playlist-secondary', '연속 재생 중지');
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      try { await chrome.runtime.sendMessage({ type: 'icampus-playlist-stop' }); }
      catch { stop.disabled = false; }
      selectingLectures = false;
      selectedLectureKeys.clear();
      persistPlaylistSelection();
      if (lastResult) render(lastResult);
      renderPlaylistStatus(null);
    });
    toolbar.append(stop);
    container.append(toolbar);
  }
}

async function refreshPlaylistStatus() {
  try {
    const saved = await chrome.storage.session.get('icampusPlaylistState');
    renderPlaylistStatus(saved.icampusPlaylistState);
  } catch { renderPlaylistStatus(null); }
}

function render(result) {
  lastResult = result;
  const pending = result.items.filter(item => !item.done);
  const pendingKeys = new Set(pending.filter(item => item.type === '강의').map(item => item.key));
  for (const key of selectedLectureKeys) if (!pendingKeys.has(key)) selectedLectureKeys.delete(key);
  if (!pendingKeys.size) selectingLectures = false;
  const completed = result.items.filter(item => item.done);
  const lectures = pending.filter(item => item.type === '강의');
  document.querySelector('#lecture').replaceChildren(
    ...(lectures.length ? [playlistToolbar()] : []),
    createTable(lectures, '강의', 'lecture')
  );
  document.querySelector('#assignment').replaceChildren(
    createTable(pending.filter(item => item.type === '과제'), '과제', 'assignment')
  );
  const completedPanel = document.querySelector('#completed');
  const completedItems = document.querySelector('#completed-items');
  completedItems.replaceChildren();
  for (const type of ['강의', '과제']) {
    const matches = completed.filter(item => item.type === type);
    if (matches.length) completedItems.append(createTable(matches, type, 'completed-' + type));
  }
  document.querySelector('#completed-count').textContent = String(completed.length);
  completedPanel.hidden = completed.length === 0;
  const status = document.querySelector('#sync-status');
  status.replaceChildren();
  if (result.warnings && result.warnings.length) {
    const details = element('details');
    details.append(
      element('summary', '', '일부 강의·과제를 확인하지 못했습니다 (' + result.warnings.length + '건)'),
      element('p', '', result.warnings.join(' / '))
    );
    status.append(details);
  }
}

async function load() {
  if (!activeTab || loading) return;
  loading = true;
  showLoading();
  const button = document.querySelector('#refresh-button');
  button.disabled = true;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id }, files: ['executescript.js']
    });
    const result = injected[0]?.result;
    if (!result || result.fatal) throw new Error(result?.fatal || '응답이 없습니다.');
    render(result);
  } catch (error) {
    const closedTab = /No tab with id|tab was closed|No tab with given id/i.test(String(error?.message));
    showError(closedTab
      ? '아이캠퍼스 탭이 닫히거나 바뀌었습니다. 해당 탭에서 확장을 다시 열어 주세요.'
      : error.message + ' 아이캠퍼스 탭을 새로고침한 뒤 다시 시도해 주세요.');
  } finally {
    loading = false;
    button.disabled = false;
  }
}

async function requestPlaylistStart(message) {
  const manifest = chrome.runtime.getManifest();
  if (manifest.version !== BUILD_VERSION || !manifest.background?.service_worker) {
    setTimeout(() => chrome.runtime.reload(), 600);
    throw new Error('확장 업데이트를 적용합니다. 잠시 후 확장을 다시 열어 재생해 주세요.');
  }
  try { return await chrome.runtime.sendMessage(message); }
  catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(error.message))) throw error;
    const saved = await chrome.storage.local.get('icampusWorkerReloadedFor');
    if (saved.icampusWorkerReloadedFor !== BUILD_VERSION) {
      await chrome.storage.local.set({ icampusWorkerReloadedFor: BUILD_VERSION });
      setTimeout(() => chrome.runtime.reload(), 600);
      throw new Error('재생 연결을 다시 설정합니다. 잠시 후 확장을 다시 열어 재생해 주세요.');
    }
    throw new Error('재생 기능이 시작되지 않았습니다. 웨일 확장 관리에서 아캠체크 플러스의 오류 내용을 확인해 주세요.');
  }
}

async function startPlaylist() {
  if (!activeTab || !lastResult) return;
  const button = document.querySelector('#playlist-start');
  if (!button || !selectedLectureKeys.size) return;
  button.disabled = true;
  button.dataset.busy = '1';
  button.textContent = '재생목록 준비 중...';
  try {
    const queue = lastResult.items.filter(item => item.type === '강의' && !item.done &&
      selectedLectureKeys.has(item.key) && new URL(item.url).origin === CANVAS_ORIGIN)
      .map(item => ({ key: item.key, course: item.course, title: item.title, url: item.url }));
    if (!queue.length) throw new Error('선택한 강의의 아이캠퍼스 주소를 확인할 수 없습니다.');
    const response = await requestPlaylistStart({
      type: 'icampus-playlist-start', tabId: activeTab.id, queue
    });
    if (!response?.ok) throw new Error(response?.error || '재생목록을 시작하지 못했습니다.');
  } catch (error) {
    document.querySelector('#sync-status').replaceChildren(
      element('div', 'error-message', '재생목록 준비 실패: ' + error.message)
    );
  } finally {
    delete button.dataset.busy;
    updatePlaylistSelection();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshPlaylistStatus();
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'session' && changes.icampusPlaylistState) {
      renderPlaylistStatus(changes.icampusPlaylistState.newValue);
    }
  });
  try {
    const saved = await chrome.storage.local.get(['screenMode', 'darkMode', 'icampusTheme', 'icampusPlaylistDraft']);
    if (saved.icampusPlaylistDraft) {
      selectingLectures = Boolean(saved.icampusPlaylistDraft.selecting);
      for (const key of saved.icampusPlaylistDraft.keys || []) selectedLectureKeys.add(key);
    }
    if (['auto', 'light', 'dark'].includes(saved.screenMode)) screenMode = saved.screenMode;
    else {
      // 1.5.x의 팝업 전용 테마 선택을 화면 모드로 옮긴다
      // 1.5.x의 darkMode/icampusTheme는 팝업 색만 정하던 값이다. 화면 모드는 아이캠퍼스 페이지 전체에 걸리므로 '어둡게'만 옮기고 '밝게'는 자동으로 둔다
      const old = saved.darkMode === true || saved.icampusTheme === 'dark' ? true : null;
      if (old !== null) {
        screenMode = old ? 'dark' : 'light';
        await chrome.storage.local.set({ screenMode });
      }
      await chrome.storage.local.remove(['darkMode', 'icampusTheme']);
    }
  } catch { /* Keep automatic color when storage is unavailable. */ }
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    setScreenMode(darkMode() ? 'light' : 'dark');
  });
  for (const option of document.querySelectorAll('#screen-mode [data-mode]')) {
    option.addEventListener('click', () => setScreenMode(option.dataset.mode));
  }
  colorMedia.addEventListener('change', applyTheme);
  applyTheme();
  document.querySelector('#refresh-button').addEventListener('click', () => {
    const button = document.querySelector('#refresh-button');
    button.style.animation = 'spin 1s ease-in-out';
    setTimeout(() => { button.style.animation = ''; }, 1000);
    load();
  });
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  } catch { /* A tab can disappear as the popup opens. */ }
  try {
    if (!activeTab || new URL(activeTab.url).origin !== CANVAS_ORIGIN) throw new Error();
  } catch {
    showError('canvas.skku.edu에 로그인한 탭에서 확장을 열어 주세요.');
    document.querySelector('#refresh-button').disabled = true;
    return;
  }
  await load();
});
