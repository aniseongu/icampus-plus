// Alerts for quiz openings and approaching deadlines (D-018). Imported by
// background.js, so openLecture, canvasUrl and examIsActive come from there.
// Every hour the worker refreshes a small schedule (icampusScan from
// executescript.js); the popup's full scan updates it too. One alarm wakes the
// worker at the next moment an alert is due, so nothing runs in between.
const SCHEDULE_KEY = 'icampusSchedule';
const NOTIFIED_KEY = 'icampusNotified';
const NOTIFY_SETTING = 'notifyEnabled';
const LINKS_KEY = 'notificationLinks';
const SCAN_ALARM = 'icampus-scan';
const NOTIFY_ALARM = 'icampus-notify';
const HOUR_MS = 60 * 60 * 1000;
// A quiz found open later than this (the browser was off) is not announced.
const QUIZ_STALE_MS = 6 * HOUR_MS;
const NOTIFIED_TTL_MS = 30 * 24 * HOUR_MS;
let notifyQueue = Promise.resolve();

function queueNotify(task) {
  const next = notifyQueue.then(task);
  notifyQueue = next.catch(() => {});
  return next;
}

async function notificationsEnabled() {
  const saved = await chrome.storage.local.get(NOTIFY_SETTING);
  return saved[NOTIFY_SETTING] !== false;
}

function scheduleItem(item) {
  const text = value => typeof value === 'string' ? value.slice(0, 300) : '';
  const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  if (!item || typeof item.key !== 'string' || !canvasUrl(item.url)) return null;
  return {
    key: item.key, type: item.type === '강의' ? '강의' : '과제', course: text(item.course), title: text(item.title),
    url: canvasUrl(item.url), due: time(item.due), opensAt: time(item.opensAt),
    done: item.done === true, closed: typeof item.closed === 'string' ? item.closed : null, quiz: item.quiz === true
  };
}

// Courses a scan could not load keep their cached items: lectures when the
// worker had no LearningX token, assignments when a course request failed.
// Attended lectures leave. Another account replaces the whole schedule.
async function updateSchedule(result) {
  if (!result || !Array.isArray(result.items)) return;
  const saved = (await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY];
  const userId = typeof result.userId === 'string' ? result.userId : null;
  const sameUser = !userId || !saved?.userId || saved.userId === userId;
  const cached = sameUser && Array.isArray(saved?.items) ? saved.items : [];
  const ids = value => new Set(Array.isArray(value) ? value.map(String) : []);
  const attended = ids(result.doneLectureKeys);
  const failedAssignments = ids(result.failedAssignmentCourses);
  const failedModules = ids(result.failedModuleCourses);
  const courseOf = key => key.split(':')[0];
  const fresh = result.items.map(scheduleItem).filter(Boolean);
  const keys = new Set(fresh.map(item => item.key));
  const keep = cached.filter(item => !keys.has(item.key) && (item.type === '강의'
    ? (!result.moduleSources || failedModules.has(courseOf(item.key))) && !attended.has(item.key)
    : !result.assignmentSources || failedAssignments.has(courseOf(item.key))));
  await chrome.storage.local.set({ [SCHEDULE_KEY]: {
    items: [...fresh, ...keep], userId: userId || (sameUser ? saved?.userId || null : null), fetchedAt: Date.now()
  } });
}

// LearningX needs the xn_api_token cookie. Read it from an open iCampus tab if
// there is one; it is used for this scan only and never stored.
async function readLearningXToken() {
  const tabs = await chrome.tabs.query({ url: 'https://canvas.skku.edu/*' });
  for (const tab of tabs) {
    if (!tab.id || tab.discarded || !tab.url || new URL(tab.url).pathname.startsWith('/xn-sso/') ||
        ExamMode.EXAM_URL.test(tab.url)) continue;
    try {
      const [read] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const part = document.cookie.split('; ').find(row => row.startsWith('xn_api_token='));
        return part ? decodeURIComponent(part.slice('xn_api_token='.length)) : null;
      } });
      if (read?.result) return read.result;
    } catch { /* Try the next tab. */ }
  }
  return null;
}

async function backgroundScan() {
  if (!(await notificationsEnabled()) || await examIsActive()) return;
  let result;
  try { result = await icampusScan({ token: await readLearningXToken() }); }
  catch { return; }
  // Signed out or Canvas down: keep the last schedule and stay quiet.
  if (!result || result.fatal) return;
  await updateSchedule(result);
}

function remainingText(ms) {
  const hours = ms / HOUR_MS;
  if (hours >= 20) return '하루';
  if (hours >= 1) return Math.round(hours) + '시간';
  return Math.max(1, Math.round(ms / 60000)) + '분';
}

function shortCourse(name) {
  const course = String(name || '').replace(/_/g, ' ');
  return course.replace(/\s+[A-Z]{2,}\d{3,}.*$/i, '').trim() || course;
}

// "오후 3:15"(오늘), "내일 오후 11:59", "10월 26일 오전 12:00"
function whenText(iso) {
  const date = new Date(iso);
  const start = day => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((start(date) - start(new Date())) / (24 * HOUR_MS));
  const time = date.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return time;
  return (days === 1 ? '내일' : (date.getMonth() + 1) + '월 ' + date.getDate() + '일') + ' ' + time;
}

// Windows shows the icon at left and three short lines beside it: the title,
// the item (message) and "course, when it closes" (context). Windows breaks
// Korean at any character, so no line should need to wrap. One icon per kind, same tile as
// the toolbar icon (docs/extensions/icampus-check-icon/notify/).
async function showNotification(item, kind, left) {
  const quiz = kind === 'open';
  const title = quiz
    ? (/시험|exam/i.test(item.title) ? '시험이 열렸어요' : '퀴즈가 열렸어요')
    : item.type + ' 마감까지 ' + remainingText(left) + ' 남았어요';
  const icon = quiz ? 'notify-quiz' : item.type === '강의' ? 'notify-lecture' : 'notify-assignment';
  const course = shortCourse(item.course);
  const context = quiz
    ? course + (item.due ? ', ' + whenText(item.due) + '까지' : '')
    : course + ', ' + whenText(item.due) + ' 마감';
  const id = 'icampus-' + crypto.randomUUID();
  await chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/' + icon + '.png', title,
    message: item.title, contextMessage: context,
    // A quiz may close in ten minutes, so its alert stays until it is dismissed.
    // Windows then adds 닫기; the open button pairs with it.
    priority: kind === '1d' ? 1 : 2, requireInteraction: quiz,
    ...(quiz ? { buttons: [{ title: /시험|exam/i.test(item.title) ? '시험 열기' : '퀴즈 열기' }] } : {})
  });
  const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
  links[id] = { url: item.url, lecture: item.type === '강의' };
  await chrome.storage.session.set({ [LINKS_KEY]: links });
}

// Quizzes: once when they open. Assignments that can be submitted and lectures
// not attended yet: once when 24 hours are left and once at 3 hours. A missed
// moment (the browser was off) still alerts once, with the real time left.
async function checkNotifications() {
  // During an exam keep the pending alarm; exam end runs this again (listener below).
  if (await examIsActive()) return;
  await chrome.alarms.clear(NOTIFY_ALARM);
  if (!(await notificationsEnabled())) return;
  const saved = await chrome.storage.local.get([SCHEDULE_KEY, NOTIFIED_KEY]);
  const now = Date.now();
  const notified = Object.fromEntries(Object.entries(saved[NOTIFIED_KEY] || {})
    .filter(([, time]) => now - time < NOTIFIED_TTL_MS));
  let next = Infinity;
  for (const item of saved[SCHEDULE_KEY]?.items || []) {
    if (item.done) continue;
    const due = item.due ? Date.parse(item.due) : NaN;
    const opens = item.quiz && item.opensAt ? Date.parse(item.opensAt) : NaN;
    // A quiz with an opening time alerts once when it opens; anything else,
    // including a quiz-like title without one, follows the deadline alerts.
    if (Number.isFinite(opens) && item.closed !== 'offline') {
      if (opens > now) { next = Math.min(next, opens); continue; }
      if (now - opens > QUIZ_STALE_MS || due <= now || notified[item.key + '|open']) continue;
      await showNotification(item, 'open');
      notified[item.key + '|open'] = now;
      continue;
    }
    if (!Number.isFinite(due) || due <= now || (item.type === '과제' && item.closed)) continue;
    const left = due - now;
    const tier = left <= 3 * HOUR_MS ? '3h' : left <= 24 * HOUR_MS ? '1d' : null;
    if (tier && !notified[item.key + '|' + tier]) {
      await showNotification(item, tier, left);
      notified[item.key + '|' + tier] = now;
      if (tier === '3h') notified[item.key + '|1d'] ||= now;
    }
    for (const moment of [due - 24 * HOUR_MS, due - 3 * HOUR_MS]) if (moment > now) next = Math.min(next, moment);
  }
  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
  if (next < Infinity) await chrome.alarms.create(NOTIFY_ALARM, { when: next + 1000 });
}

async function ensureScanAlarm() {
  if (!(await notificationsEnabled())) {
    await chrome.alarms.clear(SCAN_ALARM);
    await chrome.alarms.clear(NOTIFY_ALARM);
    return;
  }
  if (!(await chrome.alarms.get(SCAN_ALARM))) {
    await chrome.alarms.create(SCAN_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SCAN_ALARM) {
    queueNotify(async () => { await backgroundScan(); await checkNotifications(); });
  } else if (alarm.name === NOTIFY_ALARM) {
    queueNotify(checkNotifications);
  }
});
chrome.runtime.onInstalled.addListener(() => { queueNotify(ensureScanAlarm); });
chrome.runtime.onStartup.addListener(() => {
  queueNotify(async () => { await ensureScanAlarm(); await checkNotifications(); });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[NOTIFY_SETTING]) {
    queueNotify(async () => { await ensureScanAlarm(); await checkNotifications(); });
  }
  // Exam started or ended: catch up on alerts held during the exam.
  if ((area === 'local' && (changes.examModeManual || changes.examGuard)) || (area === 'session' && changes.examTabs)) {
    queueNotify(checkNotifications);
  }
});

function openFromNotification(id) {
  if (!id.startsWith('icampus-')) return;
  queueNotify(async () => {
    const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
    const link = links[id];
    delete links[id];
    await chrome.storage.session.set({ [LINKS_KEY]: links });
    await chrome.notifications.clear(id);
    if (!link || await examIsActive()) return;
    const url = canvasUrl(link.url) || 'https://canvas.skku.edu/';
    if (link.lecture) {
      try { await openLecture({ url, active: true }); return; }
      catch { /* Fall back to a plain tab. */ }
    }
    const tab = await chrome.tabs.create({ url, active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* No window to raise. */ }
  });
}
chrome.notifications.onClicked.addListener(openFromNotification);
chrome.notifications.onButtonClicked.addListener(id => openFromNotification(id));
chrome.notifications.onClosed.addListener(id => {
  if (!id.startsWith('icampus-')) return;
  queueNotify(async () => {
    const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
    if (!links[id]) return;
    delete links[id];
    await chrome.storage.session.set({ [LINKS_KEY]: links });
  });
});
