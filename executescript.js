// Scans the favorite courses. The popup injects this file into the signed-in
// canvas.skku.edu tab (it runs at once, see the last line). The service worker
// imports it and calls icampusScan itself for notifications: Canvas answers with
// the browser's cookies, and LearningX gets a token the worker read from an open
// tab (env.token, never stored). No credentials leave the browser.
var icampusScan = async (env = {}) => {
  const inPage = typeof document !== 'undefined';
  const base = inPage ? location.origin : 'https://canvas.skku.edu';
  const now = Date.now();
  const warnings = [];

  function cookie(name) {
    if (!inPage) return null;
    const part = document.cookie.split('; ').find(row => row.startsWith(name + '='));
    return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
  }

  function nextLink(header) {
    const part = (header || '').split(',').find(value => /rel="next"/.test(value));
    const match = part && part.match(/<([^>]+)>/);
    if (!match) return null;
    const url = new URL(match[1], base);
    return url.origin === base ? url.href : null;
  }

  async function jsonPages(path, headers = {}, budgetMs = 8000) {
    let url = new URL(path, base).href;
    const rows = [];
    const visited = new Set();
    const deadline = Date.now() + budgetMs;
    for (let page = 0; url && page < 25; page++) {
      if (visited.has(url)) throw new Error('반복된 페이지 주소');
      visited.add(url);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('조회 시간 초과');
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(remaining)
      });
      if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { status: response.status });
      const text = (await response.text()).replace(/^while\(1\);\s*/, '');
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('로그인 만료 또는 응답 형식 변경'); }
      if (!Array.isArray(data)) throw new Error('목록 응답 형식 변경');
      rows.push(...data);
      url = nextLink(response.headers.get('Link'));
    }
    if (url) throw new Error('25페이지 초과: 일부 항목을 가져오지 못함');
    return rows;
  }

  // The alert schedule is tied to this account; a different account drops it (notify.js).
  async function selfId() {
    try {
      const response = await fetch(base + '/api/v1/users/self', {
        credentials: 'include', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return null;
      const data = JSON.parse((await response.text()).replace(/^while\(1\);\s*/, ''));
      return data && data.id ? String(data.id) : null;
    } catch { return null; }
  }
  const userRequest = selfId();
  let courses;
  try {
    courses = await jsonPages('/api/v1/users/self/favorites/courses?per_page=100');
  } catch (error) {
    return { fatal: '즐겨찾기 과목을 가져오지 못했습니다. 아이캠퍼스 로그인 상태를 확인하고 새로고침해 주세요. (' + error.message + ')', warnings };
  }
  courses = [...new Map(courses.filter(c => c && c.id && c.name).map(c => [String(c.id), c])).values()];
  let token = env.token || cookie('xn_api_token');
  let tokenRefresh = null;
  const found = new Map();

  // The xn_api_token cookie goes stale while the Canvas session stays valid, and
  // LearningX then answers every call with HTTP 400 "Invalid request." (seen since
  // 2026-09). Opening the My Page tool re-issues it, so load that page once in a
  // hidden iframe and wait for the cookie to change. At most once per popup open.
  function refreshToken() {
    // The worker has no page to load My Page in; it keeps the cached lectures instead.
    if (!inPage) return Promise.resolve(null);
    tokenRefresh ||= new Promise(resolve => {
      const before = cookie('xn_api_token');
      // Only the global-navigation My Page tool; never another LTI link on the page.
      const fallback = '/accounts/1/external_tools/346?launch_type=global_navigation';
      const link = [...document.querySelectorAll('a[href*="launch_type=global_navigation"]')]
        .find(a => a.textContent.includes('마이페이지') &&
          /^\/accounts\/\d+\/external_tools\/\d+$/.test(new URL(a.href, base).pathname));
      const url = new URL(link?.getAttribute('href') || fallback, base);
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.src = url.origin === base ? url.href : base + fallback;
      const started = Date.now();
      const timer = setInterval(() => {
        const current = cookie('xn_api_token');
        const renewed = current && current !== before;
        if (!renewed && Date.now() - started < 8000) return;
        clearInterval(timer);
        frame.remove();
        resolve(renewed ? current : null);
      }, 200);
      document.body.appendChild(frame);
    });
    return tokenRefresh;
  }

  async function loadModules(id) {
    const path = '/learningx/api/v1/courses/' + id + '/modules';
    if (!token) token = await refreshToken();
    if (!token) return null;
    const used = token;
    try {
      return await jsonPages(path, { Authorization: 'Bearer ' + used });
    } catch (error) {
      if (![400, 401, 403].includes(error.status)) throw error;
      const fresh = await refreshToken();
      if (!fresh) throw new Error(error.message + ', 인증 재발급 실패');
      if (fresh === used) throw error;
      token = fresh;
      return jsonPages(path, { Authorization: 'Bearer ' + fresh });
    }
  }
  let assignmentSources = 0;
  let moduleSources = 0;
  // Courses whose source did not load; the alert schedule keeps their cached items.
  const failedAssignmentCourses = [];
  const failedModuleCourses = [];
  const moduleFailures = new Map();

  function validDue(value) {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }

  // The popup lists only tasks the user can submit now (user request 2026-10-19);
  // the rest carry a reason and show under 전체 보기. Before 1.8.11 they all looked
  // open, including ones locked until a later date and ones with nothing to submit.
  const OFFLINE_TYPES = ['none', 'on_paper', 'not_graded'];
  const unsubmittable = new Set();
  const doneLectureKeys = new Set();

  // Quizzes and online exams get an alert when they open (background.js).
  function isQuiz(assignment) {
    const types = Array.isArray(assignment.submission_types) ? assignment.submission_types : [];
    if (types.includes('online_quiz') || assignment.quiz_id || assignment.is_quiz_assignment) return true;
    return /퀴즈|시험|quiz|exam/i.test(assignment.name || '') && types.some(type => !OFFLINE_TYPES.includes(type));
  }

  function closedReason(assignment) {
    const types = Array.isArray(assignment.submission_types) ? assignment.submission_types : [];
    if (types.length && types.every(type => OFFLINE_TYPES.includes(type))) return { closed: 'offline' };
    const unlock = validDue(assignment.unlock_at);
    if (unlock && Date.parse(unlock) > now) return { closed: 'not-open', opensAt: unlock };
    const lock = validDue(assignment.lock_at);
    if (lock && Date.parse(lock) < now) return { closed: 'closed' };
    if (assignment.locked_for_user === true) return { closed: 'locked' };
    return null;
  }

  function addAssignment(course, assignment) {
    if (!assignment || !assignment.id || !assignment.name || assignment.published === false) return;
    const submission = assignment.submission || {};
    const done = Boolean(submission.submitted_at || submission.excused ||
      (submission.grade !== null && submission.grade !== undefined && submission.grade !== '') ||
      ['submitted', 'graded', 'pending_review'].includes(submission.workflow_state));
    const due = validDue(assignment.due_at || assignment.lock_at);
    const key = String(course.id) + ':assignment:' + String(assignment.id);
    // Keep open tasks, including items without a due date and overdue items
    // that still accept a late submission.
    if (done && (!due || Date.parse(due) < now)) {
      found.delete(key);
      return;
    }
    const previous = found.get(key);
    const reason = done || previous?.done ? null : closedReason(assignment);
    if (reason) unsubmittable.add(key);
    found.set(key, {
      key, course: course.name, title: assignment.name, type: '과제', due, ...reason,
      ...(isQuiz(assignment) ? { quiz: true, opensAt: validDue(assignment.unlock_at) } : {}),
      done: done || Boolean(previous?.done),
      url: assignment.html_url || base + '/courses/' + course.id + '/assignments/' + assignment.id
    });
  }

  function addModule(course, item) {
    const info = item && item.content_data;
    if (!info || !item.title || !info.due_at) return;
    const due = validDue(info.due_at);
    const assignmentId = item.content_id || info.id;
    // Attended lectures are not listed, but the playlist still needs their keys
    // to drop them (same key as the lecture entry below).
    if (info.use_attendance && (item.attendance_status === 'attendance' || item.completed)) {
      doneLectureKeys.add(String(course.id) + ':lecture:' +
        String(assignmentId || item.module_item_id || item.id || item.title + due));
    }
    if (!due || Date.parse(due) < now) return;
    const unlock = validDue(info.unlock_at);
    if (unlock && Date.parse(unlock) > now) return;
    const isAssignment = String(item.content_type || '').toLowerCase() === 'assignment';
    // Canvas already said this task cannot be submitted now; do not re-add it.
    if (isAssignment && assignmentId && unsubmittable.has(String(course.id) + ':assignment:' + String(assignmentId))) return;
    const isLecture = Boolean(info.use_attendance) && item.attendance_status !== 'attendance';
    if (!isAssignment && !isLecture) return;
    if (isAssignment && assignmentId && found.has(String(course.id) + ':assignment:' + String(assignmentId))) {
      const existing = found.get(String(course.id) + ':assignment:' + String(assignmentId));
      existing.done = existing.done || Boolean(item.completed);
      return;
    }
    if (isAssignment) {
      const sameTask = [...found.values()].find(existing => existing.type === '과제' &&
        existing.course === course.name && existing.title === item.title && existing.due === due);
      if (sameTask) {
        sameTask.done = sameTask.done || Boolean(item.completed);
        return;
      }
    }
    const key = String(course.id) + ':' + (isAssignment ? 'assignment:' : 'lecture:') +
      String(assignmentId || item.module_item_id || item.id || item.title + due);
    if (found.has(key)) return;
    const done = Boolean(item.completed);
    found.set(key, {
      key, course: course.name, title: item.title,
      type: isLecture ? '강의' : '과제', due, done,
      url: base + '/courses/' + course.id + '/modules/items/' + (item.module_item_id || item.id)
    });
  }

  async function loadCourse(course) {
    const id = encodeURIComponent(course.id);
    const assignmentRequest = jsonPages('/api/v1/courses/' + id + '/assignments?include%5B%5D=submission&per_page=100');
    const moduleRequest = loadModules(id);
    const [assignmentResult, moduleResult] = await Promise.allSettled([assignmentRequest, moduleRequest]);
    if (assignmentResult.status === 'fulfilled') {
      assignmentSources++;
      assignmentResult.value.forEach(a => addAssignment(course, a));
    } else {
      failedAssignmentCourses.push(String(course.id));
      warnings.push(course.name + ': 과제 목록 조회 실패 (' + assignmentResult.reason.message + ')');
    }
    if (moduleResult.status === 'fulfilled' && moduleResult.value) {
      moduleSources++;
      moduleResult.value.forEach(module => {
        if (Array.isArray(module.module_items)) module.module_items.forEach(item => addModule(course, item));
      });
    } else {
      failedModuleCourses.push(String(course.id));
      if (moduleResult.status === 'rejected') {
        const reason = moduleResult.reason.message;
        moduleFailures.set(reason, [...(moduleFailures.get(reason) || []), course.name]);
      }
    }
  }

  // Fetch at most eight favorite courses at once; the two sources within each
  // course run in parallel, so one slow source does not delay the other.
  let nextCourse = 0;
  async function worker() {
    while (nextCourse < courses.length) await loadCourse(courses[nextCourse++]);
  }
  await Promise.all(Array.from({ length: Math.min(8, courses.length) }, worker));
  // One line per cause, so a LearningX outage does not repeat for every course.
  for (const [reason, names] of moduleFailures) {
    warnings.push('강의콘텐츠 조회 실패 ' + names.length + '/' + courses.length + '과목 (' + reason + '): ' + names.join(', '));
  }
  // A failed course assignment request gets one short Canvas TODO fallback.
  // TODO entries outside the favorite list are never displayed.
  if (assignmentSources < courses.length) {
    try {
      const favoriteById = new Map(courses.map(course => [String(course.id), course]));
      const todo = await jsonPages('/api/v1/users/self/todo?per_page=100', {}, 3000);
      for (const entry of todo) {
        if (entry?.type !== 'submitting' || !entry.assignment) continue;
        const course = favoriteById.get(String(entry.course_id || entry.assignment.course_id));
        if (course) addAssignment(course, entry.assignment);
      }
    } catch (error) {
      warnings.push('보조 할 일 조회 실패 (' + error.message + ')');
    }
  }
  if (!token) warnings.push('강의콘텐츠 인증을 자동으로 받지 못했습니다. 아이캠퍼스 마이페이지를 한 번 연 뒤 새로고침해 주세요. 현재는 과제만 확인했습니다.');
  const items = [...found.values()].sort((a, b) =>
    (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity) ||
    a.course.localeCompare(b.course, 'ko'));
  return {
    items, warnings, courseCount: courses.length, doneLectureKeys: [...doneLectureKeys],
    assignmentSources, moduleSources, failedAssignmentCourses, failedModuleCourses,
    userId: await userRequest, fetchedAt: new Date().toISOString()
  };
};
// Injected as a file, the value of this line is what chrome.scripting returns.
typeof importScripts === 'function' ? null : icampusScan();
