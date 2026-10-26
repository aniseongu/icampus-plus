// 메시지함 전역 메뉴 숫자 바로 맞추기.
// Canvas는 안 읽은 개수를 2분 뒤부터 점점 드물게 다섯 번만 다시 받고, 받은 값을 1분 동안 sessionStorage에서 재사용한다.
// 그래서 메시지를 읽거나 안 읽음으로 바꿔도 왼쪽 메뉴 숫자가 그대로였다. 이 페이지에서 바뀐 읽음 상태만큼
// 보이는 숫자를 더하고 뺀다. 서버 조회는 하지 않는다. Canvas가 새 값을 그리면 그 값을 그대로 둔다.
(() => {
  if (window.top !== window || !location.pathname.startsWith('/conversations')) return;
  const badge = document.querySelector('#global_nav_conversations_link .menu-item__badge');
  if (!badge) return;

  let examManual = false;
  chrome.storage.local.get(['examGuard', 'examModeManual']).then(saved => {
    examManual = saved.examGuard !== false && saved.examModeManual === true;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('examGuard' in changes || 'examModeManual' in changes)) return;
    chrome.storage.local.get(['examGuard', 'examModeManual']).then(saved => {
      examManual = saved.examGuard !== false && saved.examModeManual === true;
    }).catch(() => {});
  });

  // Canvas가 배지 안을 React 포털로 그리므로 그 안은 건드리지 않는다. 같은 모양의 배지를 옆에 두고 원래 것을 숨긴다.
  let shown = null;
  let own = null;
  let bulkUntil = 0;
  const current = () => shown ?? Number((badge.textContent.match(/\d+/) || ['0'])[0]);
  const render = count => {
    shown = count;
    badge.style.display = 'none';
    if (!own) {
      own = document.createElement('span');
      own.className = 'menu-item__badge';
      own.dataset.icdUnread = '';
      badge.after(own);
    }
    own.hidden = count === 0;
    own.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'screenreader-only', textContent: `읽지 않은 메시지가 ${count}개 있습니다.` }),
      Object.assign(document.createElement('span'), { textContent: String(count) })
    );
    // 다른 페이지로 넘어가도 1분 동안 Canvas가 이 값을 쓰게 한다. 키는 Canvas가 만든 것이 있을 때만 고친다.
    try {
      const key = Object.keys(sessionStorage).find(k => /^unread_count_\d+_conversations$/.test(k));
      if (key) sessionStorage.setItem(key, JSON.stringify({ updatedAt: Date.now(), unreadCount: count }));
    } catch { /* Storage can be blocked; the badge itself is already right. */ }
  };
  new MutationObserver(() => {
    if (shown === null) return;
    // 묶음 읽음 직후 몇 초는 Canvas가 그 전에 받아 둔 숫자를 다시 그릴 수 있어 그 값만 넘긴다.
    // 그 뒤에는 원래대로 Canvas가 새로 받은 숫자를 따른다.
    const canvasCount = Number((badge.textContent.match(/\d+/) || ['0'])[0]);
    if (Date.now() < bulkUntil && canvasCount !== shown) return;
    shown = null;
    own?.remove();
    own = null;
    badge.style.display = '';
  }).observe(badge, { childList: true, subtree: true, characterData: true });

  // 대화를 열면 행 전체가 다시 그려지므로 요소가 아니라 대화 번호로 이전 상태를 기억한다.
  const known = new Map();
  // 묶음 읽음(inbox-split.js). 기다리는 동안 Canvas가 숫자를 이미 고쳤으면 그 값을 따르고 다시 빼지 않는다.
  let bulkBase = null;
  document.addEventListener('icd-inbox-bulk-start', () => { bulkBase = current(); });
  document.addEventListener('icd-inbox-bulk-read', event => {
    const base = bulkBase;
    bulkBase = null;
    if (examManual || !Number.isSafeInteger(event.detail?.read)) return;
    for (const id of event.detail.ids ?? []) known.set(`conversation-checkbox-${id}`, false);
    if (base === null || current() !== base) return;
    bulkUntil = Date.now() + 10000;
    render(Math.max(0, base - event.detail.read));
  });
  const scan = () => {
    let delta = 0;
    for (const row of document.querySelectorAll('.message-list li')) {
      const id = row.querySelector('[id^="conversation-checkbox-"]')?.id;
      const state = row.querySelector('.read-state');
      if (!id || !state) continue;
      const unread = !state.classList.contains('read');
      const before = known.get(id);
      if (before !== undefined && before !== unread) delta += unread ? 1 : -1;
      known.set(id, unread);
    }
    if (delta && !examManual) render(Math.max(0, current() + delta));
  };
  new MutationObserver(mutations => {
    if (mutations.some(m => m.target instanceof Element && m.target.closest('.message-list'))) scan();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  scan();
})();
