// LearningX의 초기 주차 선택은 position과 week_position을 혼용한다.
// 화면이 이미 받는 응답만 읽고 실제 공개일·마감일로 첫 펼침을 한 번 보정한다.
// MAIN world: 인증 값, 확장 API, 추가 요청 없이 학교 fetch의 반환값은 그대로 둔다.
(() => {
  if (location.origin !== 'https://canvas.skku.edu' ||
      !/^\/learningx\/lti\/modulebuilder\/?$/.test(location.pathname)) return;

  function chooseModule(modules, now) {
    const date = value => value ? Date.parse(value) : NaN;
    let pending = null;
    let latest = null;
    modules.forEach((module, index) => {
      if (!module || module.published === false || !Array.isArray(module.module_items)) return;
      const moduleStart = date(module.unlock_at);
      if (module.unlock_at && (!Number.isFinite(moduleStart) || moduleStart > now)) return;
      for (const item of module.module_items) {
        const info = item?.content_data;
        if (!info || item.published === false || info.published === false) continue;
        const start = date(info.unlock_at);
        if (info.unlock_at && (!Number.isFinite(start) || start > now)) continue;
        if (info.opened === false) continue;
        const released = Math.max(Number.isFinite(start) ? start : -Infinity,
          Number.isFinite(moduleStart) ? moduleStart : -Infinity);
        // 공개 날짜 없는 자료는 최신 주차 추정에 쓰지 않는다.
        // 공개 제한 없이 마감만 정해진 미완료 항목은 아래에서 따로 판단한다.
        if (Number.isFinite(released) && (!latest || released > latest.start)) {
          latest = { index, start: released };
        }
        const due = date(info.due_at);
        const late = date(info.late_at);
        const deadline = Number.isFinite(late) && late > due ? late : due;
        const lock = date(info.lock_at);
        if (item.completed !== false || item.completion_determinable === false ||
            (info.use_attendance && item.attendance_status === 'attendance') ||
            !Number.isFinite(deadline) || deadline < now ||
            (Number.isFinite(lock) && lock <= now)) continue;
        if (!pending || deadline < pending.deadline ||
            (deadline === pending.deadline && released > pending.start)) {
          pending = { index, deadline, start: released };
        }
      }
    });
    return pending?.index ?? latest?.index ?? null;
  }

  const examActive = () => {
    try {
      return localStorage.getItem('icampus-manager-exam-guard') !== 'false' &&
        (localStorage.getItem('icampus-manager-exam-manual') === 'true' ||
          /\/courses\/\d+\/quizzes\/\d+\/take(?:[/?#]|$)/.test(window.top.location.href));
    } catch { return true; }
  };
  if (examActive()) return;
  let course;
  try { course = window.top.location.pathname.match(/^\/courses\/(\d+)\//)?.[1]; }
  catch { return; }
  if (!course) return;

  const originalFetch = window.fetch;
  let active = true;
  let modules = null;
  let lessonsReady = false;
  let observer;
  let task = 0;
  let timeout;
  const restoreFetch = () => {
    // 다른 코드가 뒤에 감싼 fetch는 덮어쓰지 않는다.
    if (window.fetch === observeFetch) window.fetch = originalFetch;
  };
  const cleanup = () => {
    active = false;
    restoreFetch();
    observer?.disconnect();
    clearTimeout(task);
    clearTimeout(timeout);
    document.removeEventListener('pointerdown', onUserChoice, true);
    document.removeEventListener('keydown', onUserChoice, true);
    document.removeEventListener('click', onUserChoice, true);
    window.removeEventListener('pagehide', cleanup);
    modules = null;
  };
  const onUserChoice = event => {
    if (event.isTrusted && event.target instanceof Element && event.target.closest(
      '.xnmb-module-left-wrapper, .xnmb-link, .xnmb-all_fold-btn')) cleanup();
  };

  const apply = () => {
    if (!active || !modules || !lessonsReady) return;
    if (examActive()) { cleanup(); return; }
    const rows = [...document.querySelectorAll('.xnmb-module-outer-wrapper')];
    // 응답과 DOM의 순서·제목이 다르면 다른 주차를 누르지 않는다.
    if (rows.length !== modules.length || !rows.length || rows.some((row, i) =>
      row.querySelector('.xnmb-module-title')?.textContent.trim() !== modules[i]?.title ||
      !row.querySelector('.xnmb-module-left-wrapper[aria-expanded]'))) return;
    const index = chooseModule(modules, Date.now());
    if (index === null) { cleanup(); return; }
    const target = rows[index];
    const wanted = target.querySelector('.xnmb-module-left-wrapper');
    // 첫 펼침만 보정하고, 이후의 수동 선택은 그대로 둔다.
    observer?.disconnect();
    for (const row of rows) {
      const button = row.querySelector('.xnmb-module-left-wrapper');
      if (row !== target && button.getAttribute('aria-expanded') === 'true') button.click();
    }
    if (wanted.getAttribute('aria-expanded') !== 'true') wanted.click();
    task = setTimeout(() => {
      if (!active || examActive()) { cleanup(); return; }
      const header = document.querySelector('.xnmb-header')?.getBoundingClientRect().height || 0;
      window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - header),
        behavior: 'instant' });
      cleanup();
    }, 0);
  };
  const schedule = () => {
    if (!active || !modules || !lessonsReady) return;
    restoreFetch();
    if (!observer) {
      observer = new MutationObserver(schedule);
      observer.observe(document, { childList: true, subtree: true,
        attributes: true, attributeFilter: ['aria-expanded'] });
    }
    clearTimeout(task);
    // 두 응답 뒤 React의 초기 펼침을 기다린다. 가려진 탭에서도 실행되도록
    // requestAnimationFrame 대신 다음 이벤트 루프 작업에서 DOM 준비를 확인한다.
    task = setTimeout(() => { task = setTimeout(apply, 0); }, 0);
  };

  function observeFetch(...args) {
    const result = Reflect.apply(originalFetch, this, args);
    if (!active) return result;
    let kind;
    try {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      const method = args[1]?.method || (input instanceof Request ? input.method : 'GET');
      const match = url.pathname.match(/^\/learningx\/api\/v1\/courses\/(\d+)\/(modules|lessons)$/);
      if (url.origin !== location.origin || method.toUpperCase() !== 'GET' || match?.[1] !== course) return result;
      kind = match[2];
    } catch { return result; }
    // 호출한 쪽의 Promise/Response는 그대로 두고 clone만 비동기로 읽는다.
    result.then(response => {
      if (!active) return;
      if (!response.ok) { cleanup(); return; }
      return response.clone().json().then(data => {
        if (!active) return;
        if (!Array.isArray(data)) { cleanup(); return; }
        if (kind === 'modules') modules = data;
        else lessonsReady = true;
        schedule();
      });
    }).catch(cleanup);
    return result;
  }

  window.fetch = observeFetch;
  document.addEventListener('pointerdown', onUserChoice, true);
  document.addEventListener('keydown', onUserChoice, true);
  document.addEventListener('click', onUserChoice, true);
  window.addEventListener('pagehide', cleanup, { once: true });
  timeout = setTimeout(cleanup, 15000);
})();
