// The original popup layout is kept; this script renders the favorite-only scan
// into its lecture and assignment tables without inserting API text as HTML.
const CANVAS_ORIGIN = 'https://canvas.skku.edu';
let activeTab = null;
let loading = false;
let examNoticeShown = false;
let lastResult = null;
// 'open': only tasks that can be submitted now (default), 'all': every unfinished task.
let assignmentView = 'open';
const selectedLectureKeys = new Set();
// Lectures already in the playlist leave the lecture table; the playlist table lists them.
let playlistKeys = new Set();

async function examBlocksPopup() {
  if (ExamMode.EXAM_URL.test(activeTab?.url || '')) return true;
  const saved = await chrome.storage.local.get(['examGuard', 'examModeManual']);
  return saved.examGuard !== false &&
    (saved.examModeManual === true || (examStatus?.examTabs || 0) > 0);
}

function showExamNotice() {
  examNoticeShown = true;
  lastResult = null;
  document.querySelector('#completed').hidden = true;
  document.querySelector('#playlist-status').hidden = true;
  document.querySelector('#lecture').replaceChildren();
  document.querySelector('#sync-status').replaceChildren();
  document.querySelector('#refresh-button').disabled = true;
  const notice = element('div', 'empty-message');
  notice.append(
    element('h2', '', '시험 중이에요'),
    element('p', '', '시험이 끝날 때까지 아캠 플러스의 모든 기능을 멈췄어요. ' +
      (examStatus?.disabledCount > 0
        ? `다른 확장 ${examStatus.disabledCount}개도 잠시 꺼 두었어요.`
        : '다른 확장도 잠시 꺼 두었어요.'))
  );
  const protections = examProtectionText();
  if (protections) notice.append(element('p', '', protections));
  const blocked = examBlockedText();
  if (blocked) notice.append(element('p', '', blocked.trim()));
  document.querySelector('#assignment').replaceChildren(notice);
}

async function refreshExamStatus() {
  try {
    const status = await fetchExamStatus();
    examStatus = status;
    const active = status.manual || status.examTabs > 0 ||
      ExamMode.EXAM_URL.test(activeTab?.url || '');
    const banner = document.querySelector('#exam-banner');
    const bannerText = document.querySelector('#exam-banner-text');
    const bannerAction = document.querySelector('#exam-banner-action');
    const examActive = status.guard && active;
    banner.hidden = !examActive && status.pendingRestore === 0 &&
      !status.restoreNeedsApproval && !status.notificationsBlocked && !status.notificationRestorePending;
    if (examActive) {
      bannerText.textContent = '시험 중이에요. ' + examProtectionText() + examBlockedText() +
        (status.manual ? '' : ' 시험 화면을 벗어나면 자동으로 끝나요.');
      bannerAction.hidden = !status.manual;
      bannerAction.textContent = '시험 끝내기';
    } else {
      bannerText.textContent = status.restoreNeedsApproval
        ? '오래된 복구 기록이 있어요. 다시 켜기를 눌러 확인해 주세요'
        : status.pendingRestore > 0
          ? `확장 ${status.pendingRestore}개를 다시 켜지 못했어요`
        : '사이트 알림을 다시 허용하지 못했어요';
      bannerAction.hidden = false;
      bannerAction.textContent = '다시 켜기';
    }
    if (await examBlocksPopup()) showExamNotice();
  } catch (error) {
    logPopup('시험 상태 확인 실패')(error);
  }
}

async function refreshExamPresentation() {
  await refreshExamStatus();
  if (examNoticeShown && !await examBlocksPopup() && activeTab) {
    examNoticeShown = false;
    await load();
  }
}

function showLoading() {
  document.querySelector('#completed').hidden = true;
  document.querySelector('#lecture').replaceChildren();
  const loadingBox = element('div', 'loading');
  loadingBox.append(
    element('h2', '', '즐겨찾기 과목을 확인하는 중이에요'),
    element('div', 'spinner')
  );
  const status = element('div', 'connection-status');
  status.append(element('span', '', '강의와 과제를 불러오고 있어요'));
  loadingBox.append(status);
  document.querySelector('#assignment').replaceChildren(loadingBox);
  document.querySelector('#sync-status').replaceChildren();
}

// record: false for guidance that is not a failure, so it never fills the log.
function showError(message, record = true) {
  if (record) reportError('popup', message);
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

// A narrow column wraps between the date and "오후 3:15", never inside either.
// Course names stop at two lines so every row keeps the same height; the full name is the tooltip.
function courseCell(item) {
  const course = replaceUnderbar(item.course);
  const cell = element('td');
  cell.append(element('div', 'cell-clamp', course.replace(/\s+[A-Z]{2,}\d{3,}.*$/i, '').trim() || course));
  cell.title = course;
  return cell;
}

function appendDateParts(parent, text) {
  text.split(/ (?=오[전후] )/).forEach((part, index) => {
    if (index) parent.append(' ');
    parent.append(element('span', 'nowrap', part));
  });
}

// Past the deadline but still accepting late work: count down to that instead.
function remainingTime(value, cell, lateUntil) {
  if (!value) return '기한 없음';
  const remaining = Date.parse(value) - Date.now();
  const lateLeft = lateUntil ? Date.parse(lateUntil) - Date.now() : NaN;
  if (remaining < 0 && lateLeft > 0) {
    cell.classList.add('urgent');
    return '지각 ' + msToTime(lateLeft);
  }
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
    } catch (error) { logPopup('강의 탭 열기 요청 실패')(error); /* Falls back to a plain tab. */ }
  }
  chrome.tabs.create({ url, active: !background, ...(openerTabId ? { openerTabId } : {}) }).catch(logPopup('탭 열기 실패'));
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

function createTable(items, captionText, type, captionExtra, captionHelp) {
  const empty = element('div', 'empty-message', '남은 ' + captionText + '가 없어요');
  if (!items.length && !captionExtra) return empty;
  const captionRow = element('span', 'caption-row', captionText);
  const badge = setBadgeCount(element('span', 'badge'), items.length);
  badge.id = type + '-count';
  captionRow.append(badge);
  // The hint sits in the free space between the title and the buttons.
  if (captionHelp) captionRow.append(captionHelp);
  if (captionExtra) captionRow.append(captionExtra);
  // Keep the title and its buttons when the filter leaves nothing to show.
  if (!items.length) {
    const box = element('div');
    box.append(element('div', 'caption-standalone'), empty);
    box.firstChild.append(captionRow);
    return box;
  }
  const table = element('table', type);
  const caption = element('caption');
  caption.append(captionRow);
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
    row.append(courseCell(item));
    const title = element('td', 'title');
    if (type === 'lecture') {
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
    const dateCell = element('td');
    appendDateParts(dateCell, displayDate(item.due));
    if (item.lateUntil && !item.closed) {
      // A short line under the deadline; the full sentence is the tooltip.
      const late = new Date(item.lateUntil);
      const lateLine = element('span', 'setting-help late-until');
      appendDateParts(lateLine, '지각 ' + (late.getMonth() + 1) + '월 ' + late.getDate() + '일 ' +
        late.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }));
      lateLine.title = '지각 제출은 ' + displayDate(item.lateUntil) + '까지 받아요';
      dateCell.append(lateLine);
    }
    row.append(dateCell);
    const timeCell = element('td');
    if (item.closed) {
      row.classList.add('closed-task');
      timeCell.textContent = closedText(item);
    } else {
      timeCell.textContent = remainingTime(item.due, timeCell, item.lateUntil);
    }
    row.append(timeCell);
    body.append(row);
  });
  table.append(body);
  return table;
}

function closedText(item) {
  if (item.closed === 'offline') return '제출 없음';
  if (item.closed === 'not-open' && item.opensAt) {
    const opens = new Date(item.opensAt);
    return (opens.getMonth() + 1) + '월 ' + opens.getDate() + '일 열림';
  }
  if (item.closed === 'closed') return '제출 마감';
  return '잠김';
}

// One toggle at the right end of the 과제 title, shown only when some tasks cannot
// be submitted now (locked, not open yet, or nothing to submit online). Off lists
// what can be submitted; on is the pre-1.8.11 list with the reason in each row.
function assignmentViewToggle() {
  const toggle = element('button', 'playlist-action caption-toggle', '모두 보기');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', String(assignmentView === 'all'));
  toggle.addEventListener('click', () => {
    assignmentView = assignmentView === 'all' ? 'open' : 'all';
    chrome.storage.local.set({ assignmentView }).catch(logPopup('과제 보기 저장 실패'));
    if (lastResult) render(lastResult);
    document.querySelector('#assignment .caption-toggle')?.focus();
  });
  return toggle;
}

// The lecture table is always ready to pick from; there is no mode to open or close.
// Buttons sit on the title line like the playlist's clear button; the hint goes under the title.
function playlistControls() {
  const actions = element('div', 'caption-actions');
  const button = (label, className, handler) => {
    const control = element('button', 'playlist-action ' + className, label);
    control.type = 'button';
    control.addEventListener('click', handler);
    actions.append(control);
    return control;
  };
  const count = element('span', 'setting-help caption-help');
  count.id = 'playlist-selected-count';
  const all = button('모두 선택', 'playlist-secondary', () => {
    const checks = [...document.querySelectorAll('table.lecture input[type="checkbox"]')];
    const target = !checks.every(check => check.checked);
    checks.forEach(check => {
      if (check.checked !== target) { check.checked = target; check.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  });
  all.id = 'playlist-select-all';
  const play = button('', 'playlist-primary', startPlaylist);
  play.id = 'playlist-start';
  queueMicrotask(updatePlaylistSelection);
  return [actions, count];
}

// Every render and every box of 모두 선택 lands here. One write per task, and only
// when the picks changed.
let savedPlaylistDraft = null;
let playlistDraftQueued = false;
function persistPlaylistSelection() {
  if (playlistDraftQueued) return;
  playlistDraftQueued = true;
  queueMicrotask(() => {
    playlistDraftQueued = false;
    const keys = [...selectedLectureKeys];
    const signature = keys.join('\n');
    if (signature === savedPlaylistDraft) return;
    savedPlaylistDraft = signature;
    chrome.storage.local.set({ icampusPlaylistDraft: { keys } }).catch(error => {
      savedPlaylistDraft = null;
      logPopup('강의 선택 저장 실패')(error);
    });
  });
}

function updatePlaylistSelection() {
  persistPlaylistSelection();
  const size = selectedLectureKeys.size;
  const count = document.querySelector('#playlist-selected-count');
  const play = document.querySelector('#playlist-start');
  const all = document.querySelector('#playlist-select-all');
  const checks = [...document.querySelectorAll('table.lecture input[type="checkbox"]')];
  // While a playlist exists, picked lectures are added to it instead of replacing it.
  const adding = playlistKeys.size > 0;
  if (count) count.textContent = size ? size + '개 골랐어요' : adding ? '재생 목록에 추가할 강의를 골라 주세요' : '재생할 강의를 골라 주세요';
  if (all) all.textContent = checks.length && checks.every(check => check.checked) ? '선택 해제' : '모두 선택';
  if (play && !play.dataset.busy) {
    play.disabled = size === 0;
    play.textContent = adding ? (size ? size + '개 추가하기' : '재생 목록에 추가하기') : (size ? size + '개 재생하기' : '강의 재생하기');
  }
}

function formatPlaybackTime(value) {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function playlistStatusText(state) {
  if (state.status === 'opening') return '아이캠퍼스에서 강의를 여는 중...';
  if (state.status === 'connecting') return '학교 영상 플레이어에 연결하는 중...';
  if (state.status === 'blocked') return '강의 화면을 한 번 눌러 재생해 주세요';
  if (state.status === 'ended-unconfirmed') return '영상이 끝났어요. 아이캠퍼스에서 완료 표시를 확인해 주세요';
  if (state.status === 'error') return '강의를 열지 못했어요. ' + (state.error || '다시 시도해 주세요');
  if (state.status === 'halted') return '일시중지했어요. 재생을 누르면 이어서 들어요';
  const progress = formatPlaybackTime(state.currentTime) +
    (state.duration > 0 ? ' / ' + formatPlaybackTime(state.duration) : '');
  const rate = state.rate > 0 ? Number(state.rate).toString() + '배속 ' : '';
  return rate + (state.status === 'playing' ? '재생 중 ' : '일시중지 ') + progress;
}

let playlistFocus = null;
let playlistSortable = null;
let playlistDragging = false;
let playlistPending;
let playlistSignature = '';
// Keys this popup took out itself (삭제, 모두 삭제, already-done sync). Their leaving needs
// no rescan; only a lecture that finished playing does.
const expectedPlaylistLeaves = new Set();

// Six-dot grip. Drag it (SortableJS) or focus it and press the arrow keys.
function gripIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cx, cy] of [[5, 3], [9, 3], [5, 7], [9, 7], [5, 11], [9, 11]]) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', '1.3');
    svg.append(dot);
  }
  return svg;
}

// The lecture goes back to the lecture table; focus moves to the row that takes its place.
async function removeFromPlaylist(key, focusKey) {
  for (const control of document.querySelectorAll('#playlist-status button')) control.disabled = true;
  playlistFocus = focusKey ? { key: focusKey } : null;
  playlistPending = undefined;
  expectedPlaylistLeaves.add(key);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'icampus-playlist-remove', key });
    if (!response?.ok) throw new Error(response?.error || '강의를 빼지 못했어요.');
    playlistKeys.delete(key);
    if (lastResult && !examNoticeShown) render(lastResult);
  } catch (error) {
    expectedPlaylistLeaves.delete(key);
    playlistFocus = null;
    playlistSignature = '';
    document.querySelector('#sync-status').replaceChildren(
      element('div', 'error-message', '재생 목록에서 강의를 빼지 못했어요. ' + error.message));
    await refreshPlaylistStatus();
  }
}

async function reorderPlaylist(keys, focus) {
  for (const control of document.querySelectorAll('#playlist-status button')) control.disabled = true;
  playlistFocus = focus;
  playlistPending = undefined;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'icampus-playlist-reorder', keys });
    if (!response?.ok) throw new Error(response?.error || '순서를 바꾸지 못했어요.');
  } catch (error) {
    playlistFocus = null;
    playlistSignature = '';
    document.querySelector('#sync-status').replaceChildren(
      element('div', 'error-message', '재생 목록 순서를 바꾸지 못했어요. ' + error.message));
    await refreshPlaylistStatus();
  }
}

function renderPlaylistStatus(state) {
  const container = document.querySelector('#playlist-status');
  const queuedKeys = new Set(state?.queue?.map(item => item.key) || []);
  // Redraw the lecture table when lectures join the playlist. A lecture that leaves it
  // finished playing; the rescan that follows moves it to the completed list.
  const joined = [...queuedKeys].some(key => !playlistKeys.has(key));
  playlistKeys = queuedKeys;
  if (joined && lastResult && !examNoticeShown) render(lastResult);
  // Never rebuild the table under a drag; render the latest state when it ends.
  if (playlistDragging) { playlistPending = state; return; }
  const signature = state?.queue?.length ? JSON.stringify([state.queue.map(item => item.key), state.status,
    Boolean(state.soundBlocked)]) : '';
  const stateCell = container.querySelector('.playlist-current .playlist-state');
  // Progress ticks only change the current lecture's line; keep focus and the table as they are.
  if (signature && signature === playlistSignature && stateCell) {
    stateCell.textContent = stateCell.title = playlistStatusText(state);
    return;
  }
  playlistSignature = signature;
  playlistSortable?.destroy();
  playlistSortable = null;
  container.replaceChildren();
  if (!state?.queue?.length) { container.hidden = true; return; }
  container.hidden = false;
  const queue = state.queue;
  const keys = queue.map(item => item.key);
  const table = element('table', 'playlist-status-table');
  const caption = element('caption');
  const captionRow = element('span', 'caption-row', '재생 목록');
  caption.append(captionRow);
  captionRow.append(setBadgeCount(element('span', 'badge'), queue.length));
  const stop = element('button', 'playlist-action playlist-secondary playlist-stop',
    '모두 삭제');
  stop.type = 'button';
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    for (const key of keys) expectedPlaylistLeaves.add(key);
    try { await chrome.runtime.sendMessage({ type: 'icampus-playlist-stop' }); }
    catch (error) {
      logPopup('재생 목록 지우기 실패')(error);
      for (const key of keys) expectedPlaylistLeaves.delete(key);
      stop.disabled = false;
      return;
    }
    selectedLectureKeys.clear();
    persistPlaylistSelection();
    renderPlaylistStatus(null);
    if (lastResult) render(lastResult);
  });
  captionRow.append(stop);
  if (queue.length > 1) {
    stop.before(element('span', 'setting-help caption-help', '끌어서 순서를 바꾸면 맨 위부터 재생해요'));
  }
  const head = element('thead');
  const headerRow = element('tr');
  [['과목', 'colum1'], ['제목', ''], ['남은시간', 'colum4'], ['순서', 'playlist-order']].forEach(([label, className]) => {
    headerRow.append(element('th', className, label));
  });
  head.append(headerRow);
  const body = element('tbody');
  queue.forEach((item, index) => {
    const row = element('tr', index === 0 ? 'playlist-current' : '');
    const titleCell = element('td', 'playlist-title-cell');
    titleCell.append(element('div', 'playlist-lecture-title', replaceUnderbar(item.title)));
    titleCell.title = replaceUnderbar(item.title);
    if (index === 0) {
      const stateLine = element('div', 'playlist-state', playlistStatusText(state));
      stateLine.title = stateLine.textContent;
      titleCell.append(stateLine);
    }
    const timeCell = element('td');
    timeCell.textContent = remainingTime(item.due, timeCell, item.lateUntil);
    const orderCell = element('td', 'playlist-order');
    // Every row has a grip. Whatever ends up first plays now, so dragging a lecture
    // to the top (or pressing ArrowUp on the second row) switches to it.
    row.classList.add('playlist-queued');
    row.dataset.key = item.key;
    const actions = element('div', 'playlist-order-actions');
    const name = replaceUnderbar(item.title);
    const grip = element('button', 'playlist-action playlist-icon-button playlist-grip');
    grip.type = 'button';
    grip.dataset.key = item.key;
    grip.title = '끌어서 순서 바꾸기';
    grip.setAttribute('aria-label', name + ', ' + (index + 1) + '번째. 위아래 화살표 키로 순서를 바꿔요');
    grip.append(gripIcon());
    grip.addEventListener('keydown', event => {
      const target = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
      if (target === null) return;
      event.preventDefault();
      if (target < 0 || target >= queue.length) return;
      const next = [...keys];
      [next[index], next[target]] = [next[target], next[index]];
      reorderPlaylist(next, { key: item.key });
    });
    actions.append(grip);
    // The current row toggles 일시중지 and 재생. Other rows take 삭제: dragging one to
    // the top already plays it (Spotify's "Remove from this playlist" does the same job).
    if (index === 0) {
      const playing = !['error', 'halted'].includes(state.status);
      const play = element('button', 'playlist-action playlist-now-button', playing ? '일시중지' : '재생');
      play.type = 'button';
      play.setAttribute('aria-label', name + (playing ? ' 일시중지' : ' 재생'));
      play.addEventListener('click', async () => {
        if (!playing) {
          reorderPlaylist(keys, null);
          return;
        }
        play.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ type: 'icampus-playlist-halt' });
          if (response && !response.ok) throw new Error(response.error || '일시중지하지 못했어요.');
        } catch (error) { logPopup('재생 목록 일시중지 실패')(error); play.disabled = false; }
      });
      actions.append(play);
    } else {
      const remove = element('button', 'playlist-action playlist-now-button', '삭제');
      remove.type = 'button';
      remove.setAttribute('aria-label', name + ' 재생 목록에서 삭제');
      remove.addEventListener('click', () => removeFromPlaylist(item.key, keys[index + 1] || keys[index - 1]));
      actions.append(remove);
    }
    orderCell.append(actions);
    row.append(courseCell(item), titleCell, timeCell, orderCell);
    body.append(row);
  });
  table.append(caption, head, body);
  container.append(table);
  if (queue.length > 1 && globalThis.Sortable) {
    playlistSortable = Sortable.create(body, {
      draggable: 'tr.playlist-queued',
      handle: '.playlist-grip',
      animation: 0,
      ghostClass: 'playlist-drag-ghost',
      onStart: () => { playlistDragging = true; },
      onEnd: () => {
        playlistDragging = false;
        const order = [...body.querySelectorAll('tr.playlist-queued')].map(row => row.dataset.key);
        if (order.join('\n') !== keys.join('\n')) {
          playlistSignature = '';
          reorderPlaylist(order, null);
        } else if (playlistPending !== undefined) {
          const pending = playlistPending;
          playlistPending = undefined;
          renderPlaylistStatus(pending);
        }
      }
    });
  } else {
    for (const grip of body.querySelectorAll('.playlist-grip')) grip.disabled = queue.length < 2;
  }
  if (playlistFocus) {
    const target = container.querySelector(`.playlist-grip[data-key="${CSS.escape(playlistFocus.key)}"]`);
    playlistFocus = null;
    if (target && !target.disabled) target.focus();
  }
  if (state.soundBlocked && !['error', 'halted'].includes(state.status)) {
    const help = element('p', 'setting-help playlist-sound-help');
    help.append(element('span', '', '강의 화면을 한 번 누르면 다른 탭에서도 계속 재생돼요'));
    const link = element('a', '', '자동 재생 허용 파일을 설치하면 다음부터 누르지 않아도 돼요');
    link.href = 'https://github.com/aniseongu/icampus-plus#자동-재생-허용';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    help.append(document.createElement('br'), link);
    container.append(help);
  }
}

// After each scan, let the worker drop lectures that are already complete.
async function syncPlaylist(result) {
  const doneKeys = [...result.items.filter(item => item.type === '강의' && item.done).map(item => item.key),
    ...(Array.isArray(result.doneLectureKeys) ? result.doneLectureKeys : [])];
  if (!doneKeys.length) return;
  // This scan already knows they are done; their leaving needs no second scan.
  for (const key of doneKeys) if (playlistKeys.has(key)) expectedPlaylistLeaves.add(key);
  try { await chrome.runtime.sendMessage({ type: 'icampus-playlist-sync', doneKeys }); }
  catch (error) { logPopup('재생목록 정리 요청 실패')(error); /* The worker cleans up on the next scan. */ }
}

async function refreshPlaylistStatus() {
  if (await examBlocksPopup()) return;
  try {
    const saved = await chrome.storage.session.get('icampusPlaylistState');
    renderPlaylistStatus(saved.icampusPlaylistState);
  } catch { renderPlaylistStatus(null); }
}

function render(result) {
  lastResult = result;
  const pending = result.items.filter(item => !item.done);
  const lectures = pending.filter(item => item.type === '강의' && !playlistKeys.has(item.key));
  const pendingKeys = new Set(lectures.map(item => item.key));
  for (const key of selectedLectureKeys) if (!pendingKeys.has(key)) selectedLectureKeys.delete(key);
  const completed = result.items.filter(item => item.done);
  const queued = pending.some(item => item.type === '강의' && playlistKeys.has(item.key));
  document.querySelector('#lecture').replaceChildren(
    !lectures.length && queued ? element('div', 'empty-message', '남은 강의는 모두 재생 목록에 있어요')
      : createTable(lectures, '강의', 'lecture', ...(lectures.length ? playlistControls() : []))
  );
  const assignments = pending.filter(item => item.type === '과제');
  const closedCount = assignments.filter(item => item.closed).length;
  document.querySelector('#assignment').replaceChildren(
    createTable(assignmentView === 'all' ? assignments : assignments.filter(item => !item.closed), '과제', 'assignment',
      closedCount ? assignmentViewToggle() : null)
  );
  const completedPanel = document.querySelector('#completed');
  const completedItems = document.querySelector('#completed-items');
  completedItems.replaceChildren();
  for (const type of ['강의', '과제']) {
    const matches = completed.filter(item => item.type === type);
    if (matches.length) completedItems.append(createTable(matches, type, 'completed-' + type));
  }
  setBadgeCount(document.querySelector('#completed-count'), completed.length);
  completedPanel.hidden = completed.length === 0;
  const status = document.querySelector('#sync-status');
  status.replaceChildren();
  if (result.warnings && result.warnings.length) {
    const details = element('details');
    details.append(
      element('summary', '', '강의와 과제 ' + result.warnings.length + '건을 불러오지 못했어요'),
      element('p', '', result.warnings.join(' / '))
    );
    status.append(details);
  }
}

// Resolves on the tab's next finished load, or after the timeout.
function nextTabLoad(tabId, timeout = 20000) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, change) => { if (id === tabId && change.status === 'complete') done(); };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scanActiveTab() {
  const injected = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id }, files: ['executescript.js']
  });
  return injected[0]?.result;
}

async function load() {
  if (!activeTab || loading) return;
  if (await examBlocksPopup()) { showExamNotice(); return; }
  loading = true;
  showLoading();
  const button = document.querySelector('#refresh-button');
  button.disabled = true;
  try {
    let result = await scanActiveTab().catch(error => {
      if (/Frame with ID|frame was removed|was removed|navigat/i.test(String(error?.message))) return null;
      throw error;
    });
    // The tab left the page mid-scan (the playlist opening a lecture there, or a
    // click): the scan returns nothing. Scan once more after the new page loads.
    if (!result) {
      const tab = await chrome.tabs.get(activeTab.id);
      if (tab.status !== 'complete') await nextTabLoad(activeTab.id);
      result = await scanActiveTab();
    }
    if (!result || result.fatal) throw new Error(result?.fatal || '응답이 없습니다.');
    render(result);
    syncPlaylist(result);
    // The popup's full scan (with lectures) refreshes the alert schedule.
    chrome.runtime.sendMessage({ type: 'icampus-schedule', result: {
      items: result.items, doneLectureKeys: result.doneLectureKeys, userId: result.userId,
      assignmentSources: result.assignmentSources, moduleSources: result.moduleSources,
      failedAssignmentCourses: result.failedAssignmentCourses, failedModuleCourses: result.failedModuleCourses,
      courseCount: result.courseCount, grades: result.grades, gradeCourses: result.gradeCourses,
      announcements: result.announcements
    } }).catch(logPopup('일정 저장 실패'));
  } catch (error) {
    const closedTab = /No tab with id|tab was closed|No tab with given id/i.test(String(error?.message));
    showError(closedTab
      ? '아이캠퍼스 탭에서 팝업을 다시 열어 주세요.'
      : error.message + ' 아이캠퍼스 탭을 새로고침한 뒤 다시 시도해 주세요.');
  } finally {
    loading = false;
    button.disabled = false;
  }
}

// Compare the loaded manifest with the one on disk instead of a hardcoded
// constant, which went stale twice (1.5.15, 1.6.3+) and reloaded on every start.
async function diskManifestVersion() {
  try {
    const response = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    return (await response.json()).version || null;
  } catch { return null; }
}

async function requestPlaylistStart(message) {
  const manifest = chrome.runtime.getManifest();
  const diskVersion = await diskManifestVersion();
  if ((diskVersion && diskVersion !== manifest.version) || !manifest.background?.service_worker) {
    setTimeout(() => chrome.runtime.reload(), 600);
    throw new Error('확장 업데이트를 적용합니다. 잠시 후 확장을 다시 열어 재생해 주세요.');
  }
  try { return await chrome.runtime.sendMessage(message); }
  catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(error.message))) throw error;
    const saved = await chrome.storage.local.get('icampusWorkerReloadedFor');
    if (saved.icampusWorkerReloadedFor !== manifest.version) {
      await chrome.storage.local.set({ icampusWorkerReloadedFor: manifest.version });
      setTimeout(() => chrome.runtime.reload(), 600);
      throw new Error('재생 연결을 다시 설정합니다. 잠시 후 확장을 다시 열어 재생해 주세요.');
    }
    throw new Error('재생 기능이 시작되지 않았습니다. 웨일 확장 관리에서 아캠 플러스의 오류 내용을 확인해 주세요.');
  }
}

async function startPlaylist() {
  if (await examBlocksPopup()) { showExamNotice(); return; }
  if (!activeTab || !lastResult) return;
  const button = document.querySelector('#playlist-start');
  if (!button || !selectedLectureKeys.size) return;
  button.disabled = true;
  button.dataset.busy = '1';
  button.textContent = '재생 목록 준비 중...';
  try {
    const queue = lastResult.items.filter(item => item.type === '강의' && !item.done &&
      selectedLectureKeys.has(item.key) && new URL(item.url).origin === CANVAS_ORIGIN)
      // Closest deadline first; the user can reorder in the playlist table.
      .sort((a, b) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity))
      .map(item => ({ key: item.key, course: item.course, title: item.title, url: item.url, due: item.due }));
    if (!queue.length) throw new Error('선택한 강의의 아이캠퍼스 주소를 확인할 수 없습니다.');
    const response = await requestPlaylistStart({
      type: 'icampus-playlist-start', tabId: activeTab.id, queue, append: playlistKeys.size > 0
    });
    if (!response?.ok) throw new Error(response?.error || '재생 목록을 시작하지 못했어요.');
    selectedLectureKeys.clear();
    // Hide them now; the worker's state change redraws the playlist table right after.
    for (const item of queue) playlistKeys.add(item.key);
    render(lastResult);
  } catch (error) {
    const text = '재생 목록을 준비하지 못했어요. ' + error.message;
    reportError('popup', text, { stack: error.stack });
    document.querySelector('#sync-status').replaceChildren(
      element('div', 'error-message', text)
    );
  } finally {
    delete button.dataset.busy;
    updatePlaylistSelection();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  observeLightInk();
  // Color first: the exam status below waits for the worker to wake up.
  await loadScreenMode();
  colorMedia.addEventListener('change', applyTheme);
  applyTheme();
  document.querySelector('#exam-banner-action').addEventListener('click', async () => {
    const button = document.querySelector('#exam-banner-action');
    if (button.disabled || !examStatus) return;
    button.disabled = true;
    try {
      if (examStatus.manual) {
        await chrome.storage.local.set({ examModeManual: false });
        if (!examStatus.examTabs) await ExamMode.exitExamMode();
      } else if (examStatus.pendingRestore > 0 || examStatus.restoreNeedsApproval ||
          examStatus.notificationsBlocked || examStatus.notificationRestorePending) {
        await ExamMode.exitExamMode({ manualRestore: true });
      }
      await refreshExamPresentation();
    } finally { button.disabled = false; }
  });
  await refreshExamStatus();
  await refreshPlaylistStatus();
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'session' && changes.icampusPlaylistState) {
      if (!examNoticeShown) renderPlaylistStatus(changes.icampusPlaylistState.newValue);
      // A lecture finished and left the playlist: rescan so the lecture table shows it as done.
      // Lectures the popup removed itself are already back in the table.
      const after = new Set(changes.icampusPlaylistState.newValue?.queue?.map(item => item.key) || []);
      let finished = false;
      for (const item of changes.icampusPlaylistState.oldValue?.queue || []) {
        if (after.has(item.key)) continue;
        if (!expectedPlaylistLeaves.delete(item.key)) finished = true;
      }
      if (finished && lastResult && !examNoticeShown) {
        // The worker saves 'opening' and then sends this same tab to the next lecture.
        // Scanning now would be cut off by that navigation; wait for the new page.
        const next = changes.icampusPlaylistState.newValue;
        if (next?.status === 'opening' && next.tabId === activeTab?.id) nextTabLoad(activeTab.id).then(load);
        else load();
      }
    }
    if (area === 'session' && (changes.examTabs || changes.examBlockedCount ||
        changes.examDisabledIds || changes.examRestoreManualIds)) {
      refreshExamPresentation().catch(logPopup('시험 상태 표시 실패'));
    }
    if (area === 'local' && (changes.examGuard || changes.examModeManual || changes.examFullscreen ||
        changes.examDisabledIds || changes.examRestorePending || changes.examRestoreManual ||
        changes.examNotificationsBlocked)) {
      refreshExamPresentation().catch(logPopup('시험 상태 표시 실패'));
    }
  });
  try {
    const saved = await chrome.storage.local.get(['icampusPlaylistDraft', 'assignmentView']);
    if (saved.assignmentView === 'all') assignmentView = 'all';
    if (saved.icampusPlaylistDraft) {
      for (const key of saved.icampusPlaylistDraft.keys || []) selectedLectureKeys.add(key);
    }
    savedPlaylistDraft = [...selectedLectureKeys].join('\n');
  } catch (error) { logPopup('팝업 상태 읽기 실패')(error); }
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    setScreenMode(darkMode() ? 'light' : 'dark');
  });
  // Settings live in their own tab (options.html): a popup closes on any outside
  // click, which lost pasted tokens and permission prompts.
  document.querySelector('#settings-button').addEventListener('click', () => {
    chrome.runtime.openOptionsPage().catch(logPopup('설정 열기 실패'));
  });
  document.querySelector('#refresh-button').addEventListener('click', () => {
    // No spin: motion is off by default (docs/DESIGN.md §1). The loading box shows progress.
    if (examNoticeShown) return;
    load();
  });
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  } catch { /* A tab can disappear as the popup opens. */ }
  if (await examBlocksPopup()) {
    await refreshExamStatus();
    showExamNotice();
    return;
  }
  try {
    if (!activeTab || new URL(activeTab.url).origin !== CANVAS_ORIGIN) throw new Error();
  } catch {
    showError('canvas.skku.edu에 로그인한 탭에서 확장을 열어 주세요.', false);
    document.querySelector('#refresh-button').disabled = true;
    return;
  }
  await load();
});
