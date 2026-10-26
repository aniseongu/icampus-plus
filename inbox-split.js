// 옛 Canvas 메시지함의 대화를 상대 ID로 나눠 본다. 제목이나 메시지 내용은 읽지 않는다.
// Canvas 메시지 종류 선택 상자에 "일반 메시지", "학습 알림"을 더하고, 받은 편지함으로 열면 일반 메시지부터 보인다.
// 우리 항목을 고르면 Canvas는 받은 편지함 그대로 두고 행만 숨긴다. 모두 읽음은 목록 첫 줄의 안내 줄에 둔다.
(() => {
  if (window.top !== window || !location.pathname.startsWith('/conversations')) return;

  const BOT_IDS = new Set(['159841', '165997']);
  const OPTIONS = { people: 'icd-people', learning: 'icd-learning' };
  const LABELS = { people: '일반 메시지', learning: '학습 알림' };
  const ALL_LABEL = '전체 메시지';
  const NOUNS = { people: '일반 메시지', learning: '학습 알림', all: '메시지' };
  // null이면 Canvas 원래 보기다. 받은 편지함으로 처음 열 때만 일반 메시지로 시작한다.
  let view = null;
  let conversations = new Map();
  let safe = false;
  let busy = false;
  let exam = false;
  let examReady = false;
  let banner;
  let run = 0;
  let switching = false;
  let loading = false;
  let inboxLabel = null;
  // 마지막 읽음 결과. 처리 뒤 목록을 다시 받아도 남기고, 보기를 바꾸면 지운다.
  let note = '';
  const forceRead = new Set();
  const asked = new Set();

  const isBot = item => Array.isArray(item.audience) && item.audience.length > 0 &&
    item.audience.every(id => BOT_IDS.has(String(id)));

  const rowId = row => {
    const id = row.querySelector('div.select-checkbox[id^="conversation-checkbox-"]')?.id;
    return id?.match(/^conversation-checkbox-(\d+)$/)?.[1] ?? null;
  };

  const structure = () => {
    const list = document.querySelector('.message-list-scroller > .message-list');
    const course = document.querySelector('select#course-filter');
    const scope = document.querySelector('select#conversation_filter_select');
    const inbox = scope?.querySelector('option[value="inbox"]');
    return list && course && scope && inbox ? { list, scroller: list.parentElement, course, scope, inbox } : null;
  };

  // Canvas가 지금 보여 주는 종류. 우리 항목을 골라도 주소는 받은 편지함으로 남는다.
  const canvasType = () => new URLSearchParams(location.hash.replace(/^#filter=/, '').replace(/^#/, '')).get('type') || 'inbox';

  // 우리 보기에서는 목록 상자에 표시를 달아 새 행을 기본으로 가리고, 분류가 맞는 행에만 icd-inbox-match를 단다.
  // Canvas가 행을 붙인 뒤 분류하기 전까지 학습 알림이 잠깐 보이는 일이 없다. 표시를 떼면 모두 원래대로 보인다.
  // 가린 행만큼 목록이 짧아지면 Canvas가 스스로 다음 목록을 부르므로 따로 불러오지 않는다.
  const releaseRows = () => document.querySelector('.message-list-scroller')?.removeAttribute('data-icd-view');

  const unreadOf = target => [...conversations.values()].filter(item => item.unread &&
    !forceRead.has(item.id) && (target === 'all' || item.bot === (target === 'learning')));

  // 우리 항목을 선택 상자 맨 위에 넣고, 원래 "메시지함"은 "전체 메시지"로 부른다. 시험 중에는 모두 걷어 낸다.
  const ensureOptions = parts => {
    if (exam) {
      parts.scope.querySelectorAll('option[data-icd-view]').forEach(option => option.remove());
      if (inboxLabel !== null) { parts.inbox.textContent = inboxLabel; inboxLabel = null; }
      return;
    }
    if (inboxLabel === null) inboxLabel = parts.inbox.textContent;
    if (parts.inbox.textContent !== ALL_LABEL) parts.inbox.textContent = ALL_LABEL;
    for (const choice of ['learning', 'people']) {
      if (parts.scope.querySelector(`option[data-icd-view="${choice}"]`)) continue;
      const option = document.createElement('option');
      option.value = OPTIONS[choice];
      option.dataset.icdView = choice;
      parts.scope.prepend(option);
    }
    for (const choice of ['people', 'learning']) {
      const option = parts.scope.querySelector(`option[data-icd-view="${choice}"]`);
      const count = safe ? unreadOf(choice).length : 0;
      const text = count ? `${LABELS[choice]} (${count})` : LABELS[choice];
      if (option.textContent !== text) option.textContent = text;
    }
    const wanted = view ? OPTIONS[view] : null;
    if (wanted && parts.scope.value !== wanted && canvasType() === 'inbox') parts.scope.value = wanted;
  };

  // 목록 첫 줄. 지금 보기에 안 읽은 대화가 있거나 방금 처리한 결과가 있을 때만 보인다.
  const updateBanner = parts => {
    const target = view ?? (canvasType() === 'inbox' ? 'all' : null);
    const count = safe && target ? unreadOf(target).length : 0;
    if (exam || !target || (!count && !note && !busy)) { banner?.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'icd-inbox-banner';
      const text = document.createElement('span');
      text.className = 'icd-inbox-banner-text';
      text.setAttribute('role', 'status');
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'icd-inbox-banner-action';
      action.textContent = '모두 읽음으로 표시';
      action.addEventListener('click', markRead);
      banner.append(text, action);
    }
    if (banner.nextElementSibling !== parts.list) parts.list.before(banner);
    const [text, action] = banner.children;
    const message = busy ? '읽음으로 표시하고 있어요' : count ? `안 읽은 ${NOUNS[target]} ${count}개` : note;
    if (text.textContent !== message) text.textContent = message;
    action.hidden = busy || !count;
  };

  // 화면 변화는 메시지 목록 상자만 본다. 목록이 아직 없을 때만 body를 본다.
  let watched = null;
  const observer = new MutationObserver(mutations => {
    if (!examReady || exam) return;
    if (mutations.some(m => m.target instanceof Element && !m.target.closest('.icd-inbox-banner') &&
        (m.type === 'childList' || m.target.matches('input.read-state')))) scan();
  });
  function watch(parts) {
    // 목록 상자를 감싼 쪽을 봐야 Canvas가 목록 상자 자체를 바꿔 끼워도 놓치지 않는다.
    const target = parts?.scroller.parentElement ?? document.body;
    if (target === watched) return;
    observer.disconnect();
    watched = target;
    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  const render = () => {
    const parts = structure();
    watch(parts);
    if (!parts) { releaseRows(); banner?.remove(); return null; }
    if (view && !exam) parts.scroller.dataset.icdView = view;
    else parts.scroller.removeAttribute('data-icd-view');
    ensureOptions(parts);
    updateBanner(parts);
    return parts;
  };

  const api = async (url, options) => {
    // 응답이 멈추면 행을 가린 채로 남지 않게 10초에서 끊는다.
    const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(10000), ...options });
    if (!response.ok) throw new Error(`Canvas API ${response.status}`);
    const raw = await response.text();
    return { data: JSON.parse(raw.replace(/^\s*while\s*\(\s*1\s*\)\s*;\s*/, '') || '{}'), response };
  };

  const listConversations = async (scope, courseValue = '') => {
    const items = new Map();
    let url = new URL('/api/v1/conversations', location.origin);
    url.searchParams.set('per_page', '100');
    if (scope !== 'inbox') url.searchParams.set('scope', scope);
    if (courseValue && courseValue !== 'all') {
      const filter = /^\d+$/.test(courseValue) ? `course_${courseValue}` : courseValue;
      if (!/^(course|group)_\d+$/.test(filter)) throw new Error('알 수 없는 과목 필터');
      url.searchParams.set('filter[]', filter);
    }
    const visited = new Set();
    while (url && !visited.has(url.href) && visited.size < 100) {
      visited.add(url.href);
      const { data, response } = await api(url.href);
      if (!Array.isArray(data)) throw new Error('대화 목록 형식 오류');
      for (const item of data) {
        if (!/^\d+$/.test(String(item.id)) || !Array.isArray(item.audience) ||
            !['read', 'unread', 'archived'].includes(item.workflow_state)) {
          throw new Error('대화 형식 오류');
        }
        // 메시지 미리보기나 참여자 같은 내용은 버리고 분류에 쓰는 두 값만 남긴다(메모리, 개인 정보).
        const id = String(item.id);
        items.set(id, { id, bot: isBot(item), unread: item.workflow_state === 'unread' });
      }
      const next = response.headers.get('Link')?.split(',').find(part => /rel="?next"?/.test(part));
      const target = next?.match(/<([^>]+)>/)?.[1];
      url = target ? new URL(target, location.origin) : null;
      if (url && url.origin !== location.origin) throw new Error('다른 출처의 다음 페이지');
    }
    if (url) throw new Error('대화 페이지가 끝나지 않음');
    return items;
  };

  // 받은 편지함일 때만 대화 정보를 받는다. 보낸 메시지, 보관 같은 Canvas 원래 보기에는 손대지 않는다.
  const refresh = async () => {
    const serial = ++run;
    safe = false;
    loading = false;
    const parts = render();
    // 목록이 아직 없으면 여기서 끝내고, 목록이 나타나면 applyRows가 다시 부른다.
    if (!parts || exam || canvasType() !== 'inbox') { releaseRows(); return; }
    loading = true;
    try {
      const next = await listConversations('inbox', parts.course.value);
      if (serial !== run || exam) return;
      conversations = next;
      safe = true;
      loading = false;
      applyRows();
    } catch {
      if (serial !== run) return;
      // 못 받으면 우리 보기를 끄고 Canvas 목록을 그대로 보여 준다. 빈 목록으로 남기지 않는다.
      safe = false;
      loading = false;
      view = null;
      const scope = structure()?.scope;
      if (scope?.selectedOptions[0]?.dataset.icdView) scope.value = 'inbox';
      releaseRows();
      render();
    }
  };

  // Canvas는 목록을 받은 직후와 스크롤할 때만 목록이 짧은지 보고 다음 목록을 부른다.
  // Canvas가 행을 먼저 그린 뒤 우리가 가려서 짧아졌으면, 행 수가 바뀔 때마다 한 번만 스크롤 신호를 준다.
  let nudged = -1;
  const nudge = (scroller, total) => {
    if (!view || total === nudged || total >= conversations.size) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= scroller.clientHeight) return;
    nudged = total;
    scroller.dispatchEvent(new Event('scroll'));
  };

  const applyRows = () => {
    const parts = render();
    if (!parts || exam) return;
    // 우리 보기는 분류 정보가 있어야 행을 보여 줄 수 있다. 아직 없고 받는 중도 아니면 지금 받는다.
    if (!safe) { if (view && !loading) refresh(); return; }
    const rows = [...parts.list.querySelectorAll('li')];
    const matched = rows.map(row => [row, rowId(row)]);
    // 행 모양이 다르면 Canvas 화면이 바뀐 것이다. 우리 보기를 끄고 Canvas 받은 편지함으로 돌린다.
    if (matched.some(([row, id]) => !id || !row.querySelector('input.read-state'))) {
      view = null;
      parts.scope.value = 'inbox';
      render();
      return;
    }
    // 모르는 대화는 새로 온 메시지일 수 있어 한 번만 다시 받는다. 그래도 모르면 모든 보기에 그대로 둔다.
    const unknown = matched.filter(([, id]) => !conversations.has(id) && !asked.has(id));
    if (unknown.length) {
      for (const [, id] of unknown) asked.add(id);
      scheduleRefresh();
    }
    for (const [row, id] of matched) {
      // 이미 read면 손대지 않는다. 같은 값을 다시 써도 class 변경 기록이 생겨 다시 훑게 된다.
      const state = row.querySelector('input.read-state');
      if (!conversations.has(id)) { row.classList.add('icd-inbox-match'); continue; }
      if (forceRead.has(id) && !state.classList.contains('read')) state.classList.replace('unread', 'read') || state.classList.add('read');
      const bot = conversations.get(id).bot;
      row.classList.toggle('icd-inbox-match', view ? bot === (view === 'learning') : true);
    }
    nudge(parts.scroller, rows.length);
  };

  let refreshTimer;
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 350);
  };
  // 화면 변화 감시에서 바로 부른다. 타이머를 두면 Canvas가 붙인 행이 분류 전에 한 번 그려진다.
  const scan = () => {
    if (safe) {
      // 행에서 직접 읽음, 안 읽음을 바꾸면 개수에 반영한다.
      for (const row of document.querySelectorAll('.message-list li')) {
        const id = rowId(row);
        const state = row.querySelector('input.read-state');
        const item = id && conversations.get(id);
        if (!item || !state || forceRead.has(id)) continue;
        if (state.classList.contains('read')) item.unread = false;
        else if (state.classList.contains('unread')) item.unread = true;
      }
    }
    applyRows();
  };

  const setView = next => {
    if (view === next) return;
    view = next;
    note = '';
    const scroller = structure()?.scroller;
    if (scroller) scroller.scrollTop = 0;
    applyRows();
  };

  const csrf = () => {
    const value = document.cookie.split('; ').find(part => part.startsWith('_csrf_token='))?.slice(12);
    if (!value) throw new Error('CSRF 쿠키 없음');
    return decodeURIComponent(value);
  };

  const waitProgress = async progress => {
    if (!progress || typeof progress !== 'object' || !progress.url) throw new Error('진행 상태 없음');
    const url = new URL(progress.url, location.origin);
    if (url.origin !== location.origin || !/^\/api\/v1\/progress\/\d+$/.test(url.pathname)) throw new Error('진행 주소 오류');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (progress.workflow_state === 'completed') return;
      if (progress.workflow_state === 'failed') throw new Error('읽음 처리 실패');
      await new Promise(resolve => setTimeout(resolve, 1000));
      progress = (await api(url.href)).data;
    }
    throw new Error('읽음 처리 시간 초과');
  };

  async function markRead() {
    const target = view ?? 'all';
    if (!safe || busy || exam) return;
    busy = true;
    note = '';
    render();
    const failedIds = new Set();
    let done = 0;
    // 처리 중에 Canvas가 메뉴 숫자를 먼저 고칠 수 있어, 시작할 때의 숫자를 inbox-badge.js가 기억하게 한다.
    document.dispatchEvent(new CustomEvent('icd-inbox-bulk-start'));
    try {
      // 누른 시점의 서버 안 읽음 목록을 지금 과목 필터로 다시 받는다. 화면에 불러온 행만이 아니다.
      const parts = structure();
      const unreadNow = await listConversations('unread', parts?.course.value);
      const selected = [...unreadNow.values()].filter(item => target === 'all' || item.bot === (target === 'learning'));
      // 다른 탭에서 이미 읽은 대화는 여기서도 읽음으로 맞춘다. 서버에 남은 게 없으면 개수가 0이 된다.
      for (const item of conversations.values()) if (item.unread && !unreadNow.has(item.id)) item.unread = false;
      if (!selected.length) { note = '안 읽은 메시지가 없어요'; return; }
      const headers = { 'X-CSRF-Token': csrf(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
      for (let offset = 0; offset < selected.length; offset += 500) {
        if (exam) return;
        const chunk = selected.slice(offset, offset + 500);
        const body = new URLSearchParams({ event: 'mark_as_read' });
        for (const item of chunk) body.append('conversation_ids[]', String(item.id));
        try {
          const progress = (await api('/api/v1/conversations', { method: 'PUT', headers, body })).data;
          await waitProgress(progress);
        } catch {
          // 묶음 처리는 어느 대화가 실패했는지 알려 주지 않는다. 하나씩 다시 보내 실패한 것만 센다.
          for (const item of chunk) {
            if (exam) return;
            const one = new URLSearchParams({ 'conversation[workflow_state]': 'read' });
            await api(`/api/v1/conversations/${item.id}`, { method: 'PUT', headers, body: one }).catch(() => failedIds.add(item.id));
          }
        }
      }
      // 실패한 대화는 안 읽음으로 남겨 다시 누를 수 있게 한다.
      const readIds = selected.map(item => item.id).filter(id => !failedIds.has(id));
      done = readIds.length;
      const failed = failedIds.size;
      for (const id of readIds) {
        forceRead.add(id);
        if (conversations.has(id)) conversations.get(id).unread = false;
      }
      // 서버의 안 읽은 수는 처리 직후 바로 줄지 않는다. 메뉴 숫자는 inbox-badge.js가 읽은 개수만큼 뺀다.
      document.dispatchEvent(new CustomEvent('icd-inbox-bulk-read', {
        detail: { read: done, ids: readIds }
      }));
      note = failed ? `${done}개를 읽음으로 표시했어요. ${failed}개는 못 했어요.` : `${done}개를 읽음으로 표시했어요`;
      setTimeout(() => forceRead.clear(), 5000);
    } catch {
      note = done ? `${done}개를 읽음으로 표시했어요. 새로고침해서 확인해 주세요.` : '읽음으로 표시하지 못했어요. 새로고침해 주세요.';
    } finally {
      busy = false;
      applyRows();
    }
  }

  // 우리 항목을 고르면 Canvas에 알리지 않는다. Canvas가 다른 종류를 보고 있으면 받은 편지함으로 먼저 돌린다.
  document.addEventListener('change', event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || select.id !== 'conversation_filter_select' || switching) return;
    const choice = select.selectedOptions[0]?.dataset.icdView;
    if (!choice) { setView(null); return; }
    event.stopImmediatePropagation();
    if (canvasType() === 'inbox') { setView(choice); return; }
    view = choice;
    note = '';
    switching = true;
    select.value = 'inbox';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    switching = false;
    select.value = OPTIONS[choice];
  }, true);

  // 과목이나 종류를 바꾸면 Canvas가 주소의 #filter를 바꾼다. 받은 편지함이 아니면 우리 보기를 끈다.
  window.addEventListener('hashchange', () => {
    if (canvasType() !== 'inbox') view = null;
    scheduleRefresh();
  });

  const setExam = saved => {
    examReady = true;
    exam = saved.examGuard !== false && saved.examModeManual === true;
    if (exam) { ++run; safe = false; view = null; releaseRows(); render(); }
    else refresh();
  };
  chrome.storage.local.get(['examGuard', 'examModeManual']).then(saved => {
    if (canvasType() === 'inbox') view = 'people';
    setExam(saved);
  }).catch(() => { safe = false; releaseRows(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('examGuard' in changes || 'examModeManual' in changes)) return;
    chrome.storage.local.get(['examGuard', 'examModeManual']).then(setExam).catch(() => {});
  });
  watch(null);
})();
