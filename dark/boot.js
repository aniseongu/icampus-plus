// 문서가 그려지기 전에 <html data-icd="on|off">를 정한다. dark.css의 모든 규칙은 data-icd="on"일 때만 적용된다.
// 첫 화면이 밝게 번쩍이지 않도록 마지막 모드를 페이지 localStorage에 같이 적어 두고 동기로 먼저 읽는다.
// 정본은 chrome.storage.local의 screenMode('auto' | 'light' | 'dark')이고, auto는 브라우저 테마(prefers-color-scheme)를 따른다.
// 팝업(script.js)도 같은 값을 쓴다.
(() => {
  const CACHE_KEY = 'icampus-manager-screen-mode';
  const GUARD_CACHE_KEY = 'icampus-manager-exam-guard';
  const MANUAL_CACHE_KEY = 'icampus-manager-exam-manual';
  const EXAM_URL = /^https:\/\/canvas\.skku\.edu\/courses\/\d+\/quizzes\/\d+\/take(?:[/?#]|$)/;
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  let perfMode = new URLSearchParams(location.search).get('icdperf');
  if (!perfMode && /^icdperf-(light|dark)$/.test(window.name)) perfMode = window.name.slice(8);
  try { if (!perfMode && window.parent !== window) perfMode = new URLSearchParams(window.parent.location.search).get('icdperf'); } catch (e) {}
  try { if (!perfMode && window.parent !== window && /^icdperf-(light|dark)$/.test(window.parent.name)) perfMode = window.parent.name.slice(8); } catch (e) {}
  if (perfMode !== 'light' && perfMode !== 'dark') perfMode = null;
  let mode = 'auto';
  let examGuard = true;
  let examModeManual = false;

  try {
    mode = localStorage.getItem(CACHE_KEY) || 'auto';
    examGuard = localStorage.getItem(GUARD_CACHE_KEY) !== 'false';
    examModeManual = localStorage.getItem(MANUAL_CACHE_KEY) === 'true';
  } catch (e) {
    /* 저장소를 막은 환경이면 auto로 시작한다 */
  }
  if (location.href === 'about:blank' && window.parent !== window) {
    try {
      mode = window.parent.document.documentElement.dataset.icd === 'on' ? 'dark' : 'light';
    } catch (e) {
      /* 다른 출처의 부모는 읽지 않는다 */
    }
  }

  const examPage = () => {
    if (window.top === window) return EXAM_URL.test(location.href);
    try { return EXAM_URL.test(window.top.location.href); }
    catch (e) {
      try { return !window.parent.document.documentElement.hasAttribute('data-icd'); }
      catch (ignored) { return EXAM_URL.test(location.href); }
    }
  };

  const examActive = () => examGuard && (examModeManual || examPage());

  const cache = (key, value) => {
    // 실제 응시 주소에는 페이지 저장소 흔적을 남기지 않는다. 일반 페이지는 수동 모드 캐시를 갱신한다.
    if (examPage()) return;
    try { localStorage.setItem(key, value); } catch (e) { /* 캐시는 없어도 동작한다 */ }
  };

  const apply = () => {
    if (examActive()) {
      root.removeAttribute('data-icd');
      root.removeAttribute('data-icd-login');
      return;
    }
    root.dataset.icdLogin = location.pathname.startsWith('/xn-sso/') ? 'true' : 'false';
    const effectiveMode = perfMode || mode;
    const on = effectiveMode === 'dark' || (effectiveMode === 'auto' && media.matches);
    let parentOff = false;
    if (window.top !== window) {
      try { window.top.location.href; }
      catch (e) {
        try { parentOff = window.parent.document.documentElement.dataset.icd === 'off'; }
        catch (ignored) { /* 부모를 읽을 수 없으면 이 프레임 주소로 판단한다 */ }
      }
    }
    root.dataset.icd = on && !matchMedia('print').matches && !parentOff ? 'on' : 'off';
  };

  const setMode = (next) => {
    if (next !== 'light' && next !== 'dark') next = 'auto';
    mode = next;
    apply();
    cache(CACHE_KEY, mode);
  };

  apply();
  media.addEventListener('change', apply);
  matchMedia('print').addEventListener('change', apply);
  addEventListener('beforeprint', () => { if (!examActive()) root.dataset.icd = 'off'; });
  addEventListener('afterprint', apply);
  chrome.storage.local.get(['screenMode', 'darkMode', 'icampusTheme', 'examGuard', 'examModeManual']).then((v) => {
    // 1.5.x의 darkMode/icampusTheme는 팝업 색만 정하던 값이다. 화면 모드는 아이캠퍼스 페이지 전체에 걸리므로 '어둡게'만 옮기고 '밝게'는 자동으로 둔다
    const old = v.darkMode === true || v.icampusTheme === 'dark' ? 'dark' : 'auto';
    const saved = ['auto', 'light', 'dark'].includes(v.screenMode) ? v.screenMode : old;
    examGuard = v.examGuard !== false;
    examModeManual = v.examModeManual === true;
    if (!perfMode && saved !== mode) setMode(saved);
    apply();
    cache(GUARD_CACHE_KEY, String(examGuard));
    cache(MANUAL_CACHE_KEY, String(examModeManual));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!perfMode && area === 'local' && changes.screenMode) setMode(changes.screenMode.newValue);
    if (area !== 'local') return;
    if (changes.examGuard) {
      examGuard = changes.examGuard.newValue !== false;
    }
    if (changes.examModeManual) {
      examModeManual = changes.examModeManual.newValue === true;
    }
    if (changes.examGuard || changes.examModeManual) {
      apply();
      cache(GUARD_CACHE_KEY, String(examGuard));
      cache(MANUAL_CACHE_KEY, String(examModeManual));
    }
  });
})();
