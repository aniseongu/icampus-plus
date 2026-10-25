// Shared by the popup (script.js) and the settings page (options.js).
const UI_SOURCE = location.pathname.endsWith('/options.html') ? 'options' : 'popup';
window.addEventListener('error', event => {
  reportError(UI_SOURCE, event.message || '알 수 없는 오류', { stack: event.error?.stack });
});
window.addEventListener('unhandledrejection', event => {
  reportError(UI_SOURCE, String(event.reason?.message || event.reason || '처리되지 않은 오류'),
    { stack: event.reason?.stack });
});
// Handled failures still go to the error log; the popup keeps working.
const logPopup = description => error => reportError(UI_SOURCE, description + ': ' +
  String(error?.message || error || '알 수 없는 오류'), { stack: error?.stack });

// 화면 모드는 팝업과 아이캠퍼스 페이지(dark/boot.js)가 같이 쓴다: 'auto'(브라우저 설정) | 'light' | 'dark'
let screenMode = 'auto';
let examStatus = null;
const colorMedia = matchMedia('(prefers-color-scheme: dark)');

function examProtectionText() {
  if (!examStatus) return '';
  const notes = [];
  if (examStatus.notificationsBlocked) notes.push('사이트 알림을 막았어요.');
  if (examStatus.fullscreen) notes.push('시험 화면을 누르면 전체화면이 돼요.');
  return notes.join(' ');
}

function examBlockedText() {
  return examStatus?.blockedCount > 0
    ? ` 실수로 새 탭이나 창을 여는 동작을 ${examStatus.blockedCount}번 막았어요.`
    : '';
}

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
  chrome.storage.local.set({ screenMode: mode }).catch(logPopup('화면 모드 저장 실패'));
}

function element(tag, className, textValue) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== undefined) node.textContent = textValue;
  return node;
}

function setBadgeCount(badge, count) {
  const text = String(count);
  badge.textContent = text;
  badge.dataset.count = text;
  return badge;
}

// Whale recolors CSS text in the action popup, but leaves SVG filter output alone.
// Wrap only terminal text nodes: never filter a cell's painted surface or its icons.
function wrapLightInk(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!root.textContent.trim()) return;
    const parent = root.parentElement;
    if (!parent || parent.closest('svg, .badge, .nm-light-ink, script, style')) return;
    const ink = document.createElement('span');
    ink.className = 'nm-light-ink';
    root.replaceWith(ink);
    ink.append(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || root.matches('svg, .badge, .nm-light-ink, script, style')) return;
  for (const child of [...root.childNodes]) wrapLightInk(child);
}

function observeLightInk() {
  wrapLightInk(document.body);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') wrapLightInk(record.target);
      else for (const node of record.addedNodes) wrapLightInk(node);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}


async function fetchExamStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'exam-status' });
  if (status?.error) throw new Error(status.error);
  return status;
}

async function loadScreenMode() {
  try {
    const saved = await chrome.storage.local.get(['screenMode', 'darkMode', 'icampusTheme']);
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
  } catch (error) { logPopup('화면 모드 읽기 실패')(error); /* Keeps automatic color. */ }
}
