// Alerts for quiz openings and approaching deadlines (D-018). Imported by
// background.js, so openLecture, canvasUrl and examIsActive come from there.
// Every hour the worker refreshes a small schedule (icampusScan from
// executescript.js); the popup's full scan updates it too. One alarm wakes the
// worker at the next moment an alert is due, so nothing runs in between.
const SCHEDULE_KEY = 'icampusSchedule';
const NOTIFIED_KEY = 'icampusNotified';
const NOTIFY_SETTING = 'notifyEnabled';
const LINKS_KEY = 'notificationLinks';
const SCAN_STATE_KEY = 'icampusScanState';
const LEARNINGX_LAUNCH_KEY = 'learningxLaunchAt';
const LEARNINGX_TOOL_KEY = 'learningxToolId';
const ACTIVITY_KEY = 'icampusActivity';
const ACTIVITY_SETTING = 'activityNotifyEnabled';
const LEAD_SETTING = 'alertLeadMinutes';
const DAILY_TIME_SETTING = 'dailySummaryTime';
const DAILY_SENT_KEY = 'icampusDailySent';
const SCAN_ALARM = 'icampus-scan';
const NOTIFY_ALARM = 'icampus-notify';
const DAILY_ALARM = 'icampus-daily';
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ALLOWED_LEADS = [4320, 1440, 720, 360, 180, 60, 30];
// A quiz found open later than this (the browser was off) is not announced.
const QUIZ_STALE_MS = 6 * HOUR_MS;
const NOTIFIED_TTL_MS = 30 * 24 * HOUR_MS;
const ACTIVITY_TTL_MS = 60 * 24 * HOUR_MS;
const ACTIVITY_RECENT_MS = 7 * 24 * HOUR_MS;
let notifyQueue = Promise.resolve();
let scanLogQueue = Promise.resolve();
function logScanOnce(description, error) {
  const key = String(error?.name || error?.status || 'error');
  const task = scanLogQueue.then(async () => {
    const saved = (await chrome.storage.session.get('icampusScanErrorKeys')).icampusScanErrorKeys || {};
    if (saved[description] === key) return;
    await chrome.storage.session.set({ icampusScanErrorKeys: { ...saved, [description]: key } });
    reportError('notify', description + ': ' + String(error?.message || '알 수 없는 오류'),
      { stack: error?.stack });
  });
  scanLogQueue = task.catch(() => {}); // Logging failure must not interrupt or recursively log the scan.
  return scanLogQueue;
}

function withNotifyTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback()), ms);
  })]).finally(() => clearTimeout(timer));
}

function queueNotify(task) {
  const next = notifyQueue.then(task);
  notifyQueue = next.catch(error => logScanOnce('알림 작업 실패', error));
  return next;
}

// The hourly scan also feeds Google Calendar, so it runs while either is on.
async function scanWanted() {
  const saved = await chrome.storage.local.get([NOTIFY_SETTING, 'gcalEnabled']);
  return saved[NOTIFY_SETTING] !== false || saved.gcalEnabled === true;
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
    url: canvasUrl(item.url), due: time(item.due), lateUntil: time(item.lateUntil), opensAt: time(item.opensAt),
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

function activityItem(item, kind) {
  const text = value => typeof value === 'string' ? value.slice(0, 300) : '';
  const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  const url = item && canvasUrl(item.url);
  if (!url || typeof item.key !== 'string' || !item.key ||
      (kind === 'grade' && (!time(item.gradedAt) || !time(item.postedAt))) ||
      (kind === 'announcement' && !time(item.postedAt))) return null;
  return { key: text(item.key), course: text(item.course), title: text(item.title), url,
    postedAt: time(item.postedAt), ...(kind === 'grade' ? { gradedAt: time(item.gradedAt) }
      : { unread: item.unread === true }) };
}

async function showActivityNotification(items, kind) {
  const bundled = items.length >= 4;
  const first = items[0];
  const title = kind === 'grade'
    ? bundled ? '성적 ' + items.length + '개가 나왔어요' : '성적이 나왔어요'
    : bundled ? '새 공지 ' + items.length + '개가 올라왔어요' : '새 공지가 올라왔어요';
  const message = bundled ? items.slice(0, 2).map(item => item.title).join(', ') : first.title;
  const contextMessage = bundled
    ? kind === 'grade' ? '아이캠퍼스 성적에서 확인해 보세요'
      : [...new Set(items.map(item => shortCourse(item.course)))].join(', ').slice(0, 300)
    : shortCourse(first.course);
  const url = bundled ? kind === 'grade' ? 'https://canvas.skku.edu/grades'
    : 'https://canvas.skku.edu/' : first.url;
  const id = 'icampus-' + crypto.randomUUID();
  const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
  links[id] = { url, lecture: false };
  await chrome.storage.session.set({ [LINKS_KEY]: links });
  await chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/notify-assignment.png', title,
    message, contextMessage, priority: 1
  });
}

async function updateActivity(result) {
  if (!result || await examIsActive()) return;
  const hasGrades = Array.isArray(result.grades) && Array.isArray(result.gradeCourses) &&
    (result.gradeCourses.length > 0 || result.courseCount === 0);
  const hasAnnouncements = Array.isArray(result.announcements);
  if (!hasGrades && !hasAnnouncements) return;
  const saved = (await chrome.storage.local.get(ACTIVITY_KEY))[ACTIVITY_KEY];
  // Same rule as updateSchedule: an unknown id keeps the saved account.
  const scannedId = typeof result.userId === 'string' ? result.userId : null;
  const sameUser = !scannedId || !saved?.userId || saved.userId === scannedId;
  const userId = scannedId || (sameUser ? saved?.userId || null : null);
  // Grades seed per course: a course that failed the first scan alerts only
  // after its own first successful scan, so its older grades do not pile up.
  const seededCourses = new Set(sameUser && Array.isArray(saved?.seeded?.gradeCourses)
    ? saved.seeded.gradeCourses.map(String) : []);
  const seeded = { announcements: sameUser && saved?.seeded?.announcements === true };
  const seen = sameUser && saved?.seen && typeof saved.seen === 'object' && !Array.isArray(saved.seen)
    ? { ...saved.seen } : {};
  const now = Date.now();
  for (const [sig, firstSeen] of Object.entries(seen)) {
    if (!Number.isFinite(firstSeen) || now - firstSeen > ACTIVITY_TTL_MS) delete seen[sig];
  }
  const candidates = { grade: [], announcement: [] };
  for (const [kind, available, source] of [
    ['grade', hasGrades, result.grades],
    ['announcement', hasAnnouncements, result.announcements]
  ]) {
    if (!available) continue;
    for (const raw of source) {
      const item = activityItem(raw, kind);
      if (!item) continue;
      const sig = kind === 'grade' ? 'grade|' + item.key + '|' + item.gradedAt : item.key;
      if (Object.hasOwn(seen, sig)) continue;
      seen[sig] = now;
      // A regrade keeps the old posted_at, so a grade counts from the later of the two.
      const at = Math.max(Date.parse(item.postedAt), kind === 'grade' ? Date.parse(item.gradedAt) : 0);
      const recent = at <= now + 60000 && now - at <= ACTIVITY_RECENT_MS;
      const ready = kind === 'grade' ? seededCourses.has(item.key.split(':')[0]) : seeded.announcements;
      if (ready && recent && (kind === 'grade' || item.unread)) candidates[kind].push(item);
    }
    if (kind === 'announcement') seeded.announcements = true;
  }
  if (hasGrades) result.gradeCourses.forEach(id => seededCourses.add(String(id)));
  seeded.gradeCourses = [...seededCourses];
  await chrome.storage.local.set({ [ACTIVITY_KEY]: { userId, seeded, seen } });
  const enabled = await Promise.all([notificationsEnabled(), chrome.storage.local.get(ACTIVITY_SETTING)]);
  if (!enabled[0] || enabled[1][ACTIVITY_SETTING] === false) return;
  for (const kind of ['grade', 'announcement']) {
    const items = candidates[kind];
    // An exam may start while these go out; stop at the next one.
    for (const group of items.length >= 4 ? [items] : items.map(item => [item])) {
      if (await examIsActive()) return;
      await showActivityNotification(group, kind);
    }
  }
}

// LearningX needs the xn_api_token cookie. Read it from an open iCampus tab if
// there is one; it is used for this scan only and never stored.
async function readLearningXToken() {
  let expired = false;
  const readTabs = async () => {
    const tabs = await chrome.tabs.query({ url: 'https://canvas.skku.edu/*' });
    for (const tab of tabs) {
      if (expired) return null;
      if (!tab.id || tab.status !== 'complete' || tab.discarded || !tab.url ||
          new URL(tab.url).pathname.startsWith('/xn-sso/') || ExamMode.EXAM_URL.test(tab.url)) continue;
      try {
        const [read] = await withNotifyTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          const part = document.cookie.split('; ').find(row => row.startsWith('xn_api_token='));
          return part ? decodeURIComponent(part.slice('xn_api_token='.length)) : null;
        } }), 3000, () => []);
        if (expired) return null;
        if (read?.result) return read.result;
      } catch (error) { await logScanOnce('LearningX 탭 인증 읽기 실패', error); }
    }
    return null;
  };
  const result = await withNotifyTimeout(readTabs(), 8000, () => { expired = true; return null; });
  if (expired) await logScanOnce('LearningX 탭 인증 시간 초과', new Error('timeout'));
  return result;
}

async function cookiesAllowed() {
  try { return await chrome.permissions.contains({ permissions: ['cookies'] }); }
  catch (error) { await logScanOnce('쿠키 권한 확인 실패', error); return false; }
}

async function learningXCookie() {
  try {
    const value = (await chrome.cookies.get({ url: 'https://canvas.skku.edu/', name: 'xn_api_token' }))?.value;
    return value ? decodeURIComponent(value) : null;
  } catch (error) { await logScanOnce('LearningX 쿠키 읽기 실패', error); return null; }
}

async function canvasTokenJson(path, token) {
  const response = await fetch('https://canvas.skku.edu' + path, {
    credentials: 'omit', redirect: 'error',
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Canvas HTTP ' + response.status);
  return JSON.parse((await response.text()).replace(/^while\(1\);\s*/, ''));
}

async function learningXLaunchTarget(canvasToken) {
  const saved = await chrome.storage.local.get([LEARNINGX_TOOL_KEY, SCHEDULE_KEY]);
  const courseKey = saved[SCHEDULE_KEY]?.items?.find(item => /^\d+:/.test(item?.key))?.key;
  let courseId = courseKey?.split(':')[0];
  if (!courseId) {
    const favorites = await canvasTokenJson('/api/v1/users/self/favorites/courses?per_page=100', canvasToken);
    courseId = String(Array.isArray(favorites) ? favorites.find(course => /^\d+$/.test(String(course?.id)))?.id || '' : '');
  }
  if (!courseId) return null;
  if (/^\d+$/.test(String(saved[LEARNINGX_TOOL_KEY] || ''))) {
    return { courseId, toolId: String(saved[LEARNINGX_TOOL_KEY]) };
  }
  const tabs = await canvasTokenJson('/api/v1/courses/' + courseId + '/tabs', canvasToken);
  const tab = Array.isArray(tabs) && tabs.find(item =>
    typeof item?.label === 'string' && item.label.includes('강의콘텐츠') && !item.label.includes('(구)') &&
    /^context_external_tool_\d+$/.test(item.id));
  if (!tab) return null;
  const toolId = tab.id.slice('context_external_tool_'.length);
  await chrome.storage.local.set({ [LEARNINGX_TOOL_KEY]: toolId });
  return { courseId, toolId };
}

function decodeLaunchHtml(value) {
  return value.replace(/&(?:amp|quot|#39|lt|gt);/g, entity =>
    ({ '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' })[entity]);
}

function launchAttribute(tag, name) {
  const match = tag.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return match ? decodeLaunchHtml(match[1] ?? match[2] ?? match[3]) : null;
}

async function launchLearningX(canvasToken) {
  try {
    if (await examIsActive()) return null;
    const now = Date.now();
    const last = (await chrome.storage.local.get(LEARNINGX_LAUNCH_KEY))[LEARNINGX_LAUNCH_KEY];
    if (Number.isFinite(last) && now - last < HOUR_MS) return null;
    await chrome.storage.local.set({ [LEARNINGX_LAUNCH_KEY]: now });
    // Never mix accounts: if the browser is signed in as someone other than the
    // token's owner, leave that session alone. Signed out (401) is fine.
    const owner = (await CanvasToken.status()).userId;
    const session = await fetch('https://canvas.skku.edu/api/v1/users/self', {
      credentials: 'include', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000)
    });
    if (session.ok) {
      const self = JSON.parse((await session.text()).replace(/^while\(1\);\s*/, ''));
      if (!owner || String(self?.id || '') !== String(owner)) return null;
    }
    const target = await learningXLaunchTarget(canvasToken);
    if (!target || await examIsActive()) return null;
    const launch = await canvasTokenJson('/api/v1/courses/' + target.courseId +
      '/external_tools/sessionless_launch?id=' + target.toolId, canvasToken);
    const url = new URL(launch?.url);
    if (url.origin !== 'https://canvas.skku.edu' || await examIsActive()) return null;
    const page = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(8000) });
    if (!page.ok) { await logScanOnce('LearningX 도구 페이지 실패', new Error('HTTP ' + page.status)); return null; }
    if (new URL(page.url).origin !== url.origin) return null; // A redirect to login has no usable tool form.
    const html = await page.text();
    const form = html.match(/<form\b[^>]*>([\s\S]*?)<\/form\s*>/i);
    if (!form) return null;
    const action = new URL(launchAttribute(form[0].slice(0, form[0].indexOf('>') + 1), 'action') || '', page.url);
    if (!action.href.startsWith('https://canvas.skku.edu/learningx/')) return null;
    const body = new URLSearchParams();
    for (const input of form[1].matchAll(/<input\b[^>]*>/gi)) {
      const name = launchAttribute(input[0], 'name');
      if (name) body.append(name, launchAttribute(input[0], 'value') || '');
    }
    if (!body.size || await examIsActive()) return null;
    const posted = await fetch(action.href, {
      method: 'POST', credentials: 'include', body, signal: AbortSignal.timeout(8000)
    });
    if (!posted.ok) { await logScanOnce('LearningX 도구 제출 실패', new Error('HTTP ' + posted.status)); return null; }
    return learningXCookie();
  } catch (error) { await logScanOnce('LearningX 도구 실행 실패', error); return null; }
}

async function backgroundScan() {
  let expired = false;
  const scan = async () => {
    if (!(await scanWanted()) || await examIsActive()) return;
    let result;
    let canvasToken, rejected = false;
    try {
      const hasCookies = await cookiesAllowed();
      let token = hasCookies ? await learningXCookie() : await readLearningXToken();
      if (expired) return;
      canvasToken = await CanvasToken.get();
      result = await icampusScan({ token, canvasToken });
      if (expired) return;
      if (canvasToken && result?.fatal && result.status === 401) {
        await CanvasToken.markRejected();
        rejected = true;
        result = await icampusScan({ token });
      } else if (canvasToken && result && !result.fatal) {
        await CanvasToken.markOk();
      }
      if (canvasToken && hasCookies && result && !result.fatal &&
          (!token || (result.moduleSources === 0 && result.failedModuleCourses?.length > 0))) {
        const renewed = await launchLearningX(canvasToken);
        if (renewed && !expired && !(await examIsActive())) {
          token = renewed;
          try {
            const retried = await icampusScan({ token, canvasToken });
            if (retried && !retried.fatal) result = retried;
          } catch (error) { await logScanOnce('LearningX 재조회 실패', error); }
        }
      }
    }
    catch (error) { await logScanOnce('정기 일정 조회 실패', error); return; }
    if (expired || !result) return;
    if (result.fatal) {
      await logScanOnce('정기 일정 응답 실패', { name: String(result.status || 'fatal'), message: result.fatal });
      if (result.status !== 401 && !result.fatal.includes('로그인 만료 또는 응답 형식 변경')) return;
      const tokenStatus = await CanvasToken.status();
      const problem = rejected || (tokenStatus.set && tokenStatus.rejectedAt) ? 'token-rejected' : 'signed-out';
      const old = (await chrome.storage.local.get(SCAN_STATE_KEY))[SCAN_STATE_KEY] || {};
      const state = { lastOkAt: old.lastOkAt || null, problem, notifiedProblem: old.notifiedProblem || null };
      if (expired) return;
      if (state.notifiedProblem !== problem) {
        await showScanProblem(problem);
        state.notifiedProblem = problem;
      }
      if (!expired) await chrome.storage.local.set({ [SCAN_STATE_KEY]: state });
      return;
    }
    if (expired) return;
    await chrome.storage.session.remove('icampusScanErrorKeys');
    await updateSchedule(result);
    if (expired) return;
    await Gcal.syncIfEnabled();
    if (expired) return;
    await updateActivity(result);
    if (expired) return;
    await recordScanSuccess({ usedToken: Boolean(canvasToken), rejected });
  };
  const result = await withNotifyTimeout(scan(), 90000, () => { expired = true; });
  if (expired) await logScanOnce('정기 일정 조회 시간 초과', new Error('timeout'));
  return result;
}

async function recordScanSuccess({ usedToken, rejected }) {
  const old = (await chrome.storage.local.get(SCAN_STATE_KEY))[SCAN_STATE_KEY] || {};
  const tokenStatus = await CanvasToken.status();
  const state = { lastOkAt: Date.now(), problem: old.problem || null,
    notifiedProblem: old.notifiedProblem || null };
  if (rejected || (!usedToken && tokenStatus.set && tokenStatus.rejectedAt)) {
    state.problem = 'token-rejected';
    if (state.notifiedProblem !== 'token-rejected') {
      await showScanProblem('token-rejected');
      state.notifiedProblem = 'token-rejected';
    }
  } else {
    state.problem = null;
    state.notifiedProblem = null;
  }
  await chrome.storage.local.set({ [SCAN_STATE_KEY]: state });
}

async function showScanProblem(problem) {
  if (!(await notificationsEnabled())) return;
  const rejected = problem === 'token-rejected';
  const id = 'icampus-' + crypto.randomUUID();
  const url = rejected ? 'https://canvas.skku.edu/profile/settings' : 'https://canvas.skku.edu/';
  const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
  links[id] = { url, lecture: false };
  await chrome.storage.session.set({ [LINKS_KEY]: links });
  await chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/notify-assignment.png',
    title: rejected ? '토큰이 더 이상 맞지 않아요' : '아이캠퍼스 로그인이 풀렸어요',
    message: '새 과제와 퀴즈를 가져오지 못하고 있어요',
    contextMessage: rejected ? '아캠 플러스 설정에서 토큰을 다시 넣어 주세요'
      : '로그인하거나 설정에서 토큰을 넣어 주세요'
  });
}

function remainingText(ms) {
  const hours = ms / HOUR_MS;
  if (hours >= 36) return Math.round(hours / 24) + '일';
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
async function showNotification(item, kind, left, deadline = item.due, lead = null) {
  const quiz = kind === 'open';
  const title = quiz
    ? (/시험|exam/i.test(item.title) ? '시험이 열렸어요' : '퀴즈가 열렸어요')
    : kind === 'late' ? '마감이 지났어요'
      : (kind === 'late-deadline' ? '지각 제출 마감까지 ' : item.type + ' 마감까지 ') + remainingText(left) + ' 남았어요';
  const icon = quiz ? 'notify-quiz' : item.type === '강의' ? 'notify-lecture' : 'notify-assignment';
  const course = shortCourse(item.course);
  const context = quiz
    ? course + (item.due ? ', ' + whenText(item.due) + '까지' : '')
    : kind === 'late' ? course + ', 지각 제출은 ' + whenText(deadline) + '까지'
      : course + ', ' + whenText(deadline) + ' 마감';
  const id = 'icampus-' + crypto.randomUUID();
  await chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/' + icon + '.png', title,
    message: item.title, contextMessage: context,
    // A quiz may close in ten minutes, so its alert stays until it is dismissed.
    // Windows then adds 닫기; the open button pairs with it.
    priority: lead >= 720 ? 1 : 2, requireInteraction: quiz,
    ...(quiz ? { buttons: [{ title: /시험|exam/i.test(item.title) ? '시험 열기' : '퀴즈 열기' }] } : {})
  });
  const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
  links[id] = { url: item.url, lecture: item.type === '강의' };
  await chrome.storage.session.set({ [LINKS_KEY]: links });
}

function alertLeads(value) {
  return Array.isArray(value) && value.every(lead => Number.isInteger(lead) && ALLOWED_LEADS.includes(lead))
    ? [...new Set(value)].sort((a, b) => a - b) : [180, 1440];
}

function wasNotified(notified, key, lead, late) {
  return Boolean(notified[key + '|' + (late ? 'L' : 'm') + lead] || (!late &&
    ((lead === 1440 && notified[key + '|1d']) || (lead === 180 && notified[key + '|3h']))));
}

// A missed lead alerts at the smallest elapsed lead, then marks larger leads
// as handled so a later settings change cannot replay them.
async function notifyDeadline(item, due, late, leads, notified, now) {
  const left = due - now;
  if (left <= 0) return Infinity;
  const elapsed = leads.filter(lead => left <= lead * MINUTE_MS);
  const pending = elapsed.filter(lead => !wasNotified(notified, item.key, lead, late));
  if (pending.length) {
    const lead = pending[0];
    await showNotification(item, late ? 'late-deadline' : 'deadline', left,
      late ? item.lateUntil : item.due, lead);
    for (const handled of elapsed.filter(value => value >= lead)) {
      notified[item.key + '|' + (late ? 'L' : 'm') + handled] = now;
    }
  }
  let next = Infinity;
  for (const lead of leads) {
    const moment = due - lead * MINUTE_MS;
    if (moment > now) next = Math.min(next, moment);
  }
  return next;
}

// A newly chosen lead that has already passed counts as sent, so changing the
// setting never fires an alert on the spot.
async function markElapsedLeads() {
  const saved = await chrome.storage.local.get([SCHEDULE_KEY, NOTIFIED_KEY, LEAD_SETTING]);
  const leads = alertLeads(saved[LEAD_SETTING]);
  const notified = saved[NOTIFIED_KEY] || {};
  const now = Date.now();
  for (const item of saved[SCHEDULE_KEY]?.items || []) {
    const due = item.due ? Date.parse(item.due) : NaN;
    const lateUntil = item.lateUntil ? Date.parse(item.lateUntil) : NaN;
    for (const [deadline, mark] of [[due, 'm'], [lateUntil, 'L']]) {
      if (!Number.isFinite(deadline) || deadline <= now) continue;
      for (const lead of leads) {
        if (deadline - now <= lead * MINUTE_MS) notified[item.key + '|' + mark + lead] ||= now;
      }
    }
  }
  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
}

async function checkNotifications() {
  // During an exam keep the pending alarm; exam end runs this again (listener below).
  if (await examIsActive()) return;
  await chrome.alarms.clear(NOTIFY_ALARM);
  if (!(await notificationsEnabled())) return;
  const saved = await chrome.storage.local.get([SCHEDULE_KEY, NOTIFIED_KEY, LEAD_SETTING]);
  const leads = alertLeads(saved[LEAD_SETTING]);
  const now = Date.now();
  const notified = Object.fromEntries(Object.entries(saved[NOTIFIED_KEY] || {})
    .filter(([, time]) => now - time < NOTIFIED_TTL_MS));
  let next = Infinity;
  for (const item of saved[SCHEDULE_KEY]?.items || []) {
    if (item.done) continue;
    const due = item.due ? Date.parse(item.due) : NaN;
    const opens = item.quiz && item.opensAt ? Date.parse(item.opensAt) : NaN;
    const lateUntil = item.lateUntil ? Date.parse(item.lateUntil) : NaN;
    const lateOpen = Number.isFinite(due) && due <= now && Number.isFinite(lateUntil) && lateUntil > now;
    // A quiz with an opening time alerts once when it opens. Its ordinary
    // deadline remains opening-only; a later submission window still alerts.
    if (Number.isFinite(opens) && item.closed !== 'offline') {
      if (opens > now) { next = Math.min(next, opens); continue; }
      if (now - opens <= QUIZ_STALE_MS && due > now && !notified[item.key + '|open']) {
        await showNotification(item, 'open');
        notified[item.key + '|open'] = now;
      }
      if (!lateOpen) {
        if (due > now && Number.isFinite(lateUntil) && lateUntil > due) {
          next = Math.min(next, due + 1000);
        }
        continue;
      }
    }
    // Checked after the quiz block: a quiz saved as not-open still alerts when it opens.
    if (item.type === '과제' && item.closed) continue;
    if (lateOpen) {
      // The past-deadline notice follows the chosen moments (none chosen, none
      // sent) and stands in for any late-deadline moment already passed.
      if (leads.length && !notified[item.key + '|late']) {
        await showNotification(item, 'late', null, item.lateUntil);
        notified[item.key + '|late'] = now;
        for (const lead of leads) {
          if (lateUntil - now <= lead * MINUTE_MS) notified[item.key + '|L' + lead] ||= now;
        }
      }
      next = Math.min(next, await notifyDeadline(item, lateUntil, true, leads, notified, now));
    } else if (Number.isFinite(due) && due > now) {
      next = Math.min(next, await notifyDeadline(item, due, false, leads, notified, now));
      if (Number.isFinite(lateUntil) && lateUntil > due) next = Math.min(next, due + 1000);
    }
  }
  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
  if (next < Infinity) await chrome.alarms.create(NOTIFY_ALARM, { when: next + 1000 });
}

async function ensureScanAlarm() {
  if (!(await notificationsEnabled())) await chrome.alarms.clear(NOTIFY_ALARM);
  if (!(await scanWanted())) {
    await chrome.alarms.clear(SCAN_ALARM);
    return;
  }
  if (!(await chrome.alarms.get(SCAN_ALARM))) {
    await chrome.alarms.create(SCAN_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  }
}

function summaryClock(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return value.split(':').map(Number);
}

async function ensureDailyAlarm(afterScheduledTime = null) {
  const saved = await chrome.storage.local.get([NOTIFY_SETTING, DAILY_TIME_SETTING]);
  const clock = summaryClock(saved[DAILY_TIME_SETTING]);
  await chrome.alarms.clear(DAILY_ALARM);
  if (saved[NOTIFY_SETTING] === false || !clock) return;
  const now = new Date();
  const base = Number.isFinite(afterScheduledTime) ? new Date(afterScheduledTime) : now;
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), clock[0], clock[1]);
  if (Number.isFinite(afterScheduledTime)) next.setDate(next.getDate() + 1);
  while (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  await chrome.alarms.create(DAILY_ALARM, { when: next.getTime() });
}

function localDateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

async function showDailySummary(scheduledTime) {
  if (Date.now() - scheduledTime > 3 * HOUR_MS || !(await notificationsEnabled()) || await examIsActive()) return;
  await backgroundScan();
  if (!(await notificationsEnabled()) || await examIsActive()) return;
  const saved = await chrome.storage.local.get([SCHEDULE_KEY, DAILY_SENT_KEY]);
  const now = Date.now();
  const today = localDateKey(new Date(now));
  if (saved[DAILY_SENT_KEY] === today) return;
  // "오늘" means until midnight. An evening summary (18:00 or later) covers
  // tomorrow too and says so, so a morning deadline is not a surprise.
  const evening = new Date(scheduledTime).getHours() >= 18;
  const until = new Date(now);
  until.setHours(24, 0, 0, 0);
  if (evening) until.setDate(until.getDate() + 1);
  const items = (saved[SCHEDULE_KEY]?.items || []).map(item => {
    const due = item.due ? Date.parse(item.due) : NaN;
    const late = item.lateUntil ? Date.parse(item.lateUntil) : NaN;
    return { item, deadline: due > now ? due : late };
  }).filter(({ item, deadline }) => !item.done && !item.closed &&
    Number.isFinite(deadline) && deadline > now && deadline <= until.getTime())
    .sort((a, b) => a.deadline - b.deadline);
  const id = 'icampus-' + crypto.randomUUID();
  const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
  links[id] = { url: 'https://canvas.skku.edu/', lecture: false };
  await chrome.storage.session.set({ [LINKS_KEY]: links });
  await chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/notify-assignment.png',
    title: items.length ? (evening ? '내일까지 마감 ' : '오늘 마감 ') + items.length + '개가 있어요'
      : evening ? '내일까지 마감이 없어요' : '오늘은 마감이 없어요',
    message: items.length ? items.slice(0, 2).map(({ item }) => item.title).join(', ') : '편하게 쉬어도 돼요',
    ...(items.length ? { contextMessage: '가장 빠른 마감 ' + whenText(items[0].deadline) } : {}),
    priority: 1
  });
  await chrome.storage.local.set({ [DAILY_SENT_KEY]: today });
}

async function clearExamNotifications() {
  const shown = await chrome.notifications.getAll();
  const ids = Object.keys(shown).filter(id => id.startsWith('icampus-'));
  for (const id of ids) await chrome.notifications.clear(id);
  const links = (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] || {};
  for (const id of ids) delete links[id];
  await chrome.storage.session.set({ [LINKS_KEY]: links });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SCAN_ALARM) {
    queueNotify(async () => { await backgroundScan(); await checkNotifications(); });
  } else if (alarm.name === NOTIFY_ALARM) {
    queueNotify(checkNotifications);
  } else if (alarm.name === DAILY_ALARM) {
    queueNotify(async () => { await ensureDailyAlarm(alarm.scheduledTime); await showDailySummary(alarm.scheduledTime); });
  }
});
chrome.runtime.onInstalled.addListener(() => {
  queueNotify(async () => { await ensureScanAlarm(); await ensureDailyAlarm(); });
});
chrome.runtime.onStartup.addListener(() => {
  queueNotify(async () => { await ensureScanAlarm(); await ensureDailyAlarm(); await checkNotifications(); });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gcalEnabled) queueNotify(ensureScanAlarm);
  if (area === 'local' && changes[NOTIFY_SETTING]) {
    queueNotify(async () => { await ensureScanAlarm(); await ensureDailyAlarm(); await checkNotifications(); });
  }
  if (area === 'local' && changes[DAILY_TIME_SETTING]) {
    queueNotify(ensureDailyAlarm);
  }
  if (area === 'local' && changes[LEAD_SETTING]) {
    queueNotify(async () => { await markElapsedLeads(); await checkNotifications(); });
  }
  // Exam started: clear visible alerts. Exam ended: catch up on pending ones.
  if ((area === 'local' && (changes.examModeManual || changes.examGuard)) || (area === 'session' && changes.examTabs)) {
    queueNotify(async () => {
      if (await examIsActive()) await clearExamNotifications();
      else await checkNotifications();
    });
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
      catch (error) { logWorker('알림에서 강의 열기 실패', error, 'notify'); }
    }
    const tab = await chrome.tabs.create({ url, active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); }
    catch (error) { logWorker('알림 탭 포커스 실패', error, 'notify'); }
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
