// 옛 Canvas 메시지함의 받은 편지함 목록에 내가 보내기만 하고 아직 답이 없는 대화를 넣는다.
// Canvas는 상대가 답하기 전까지 보낸 대화를 받은 편지함에 두지 않고(last_message_at 없음) 보낸 메시지에만 둔다.
// MAIN world에서 Canvas가 받은 편지함 목록을 부르는 XHR만 감싼다. 첫 페이지를 부를 때 같은 과목 필터로 보낸 목록을 한 번 받고,
// 각 페이지 응답에 그 페이지 시간 범위에 드는 대화만 끼워 넣는다. 다른 요청과 보기는 건드리지 않는다.
// 켜고 끄기는 inbox-split.js가 알려 준다(시험 중에는 끔). 답을 기다리는 동안에는 Canvas 요청을 잠깐 미룬다.
(() => {
  if (window.top !== window || !location.pathname.startsWith('/conversations')) return;

  const proto = XMLHttpRequest.prototype;
  const { open, send, setRequestHeader, abort } = proto;
  const textOf = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
  const PREFIX = /^\s*while\s*\(\s*1\s*\)\s*;\s*/;
  const requests = new WeakMap();
  // 지금 보고 있는 목록 하나만 둔다. 첫 페이지 요청에서 새로 만들고, 마지막 페이지를 넣으면 보낸 목록을 버린다.
  let current = null;
  const drop = () => { current?.controller.abort(); current = null; };

  let enabled = null;
  const waiting = [];
  const decide = on => {
    enabled = on;
    if (!on) drop();
    waiting.splice(0).forEach(resolve => resolve(on));
  };
  document.addEventListener('icd-inbox-merge-on', () => decide(true));
  document.addEventListener('icd-inbox-merge-off', () => decide(false));
  const gate = () => enabled !== null ? Promise.resolve(enabled) : new Promise(resolve => {
    waiting.push(resolve);
    setTimeout(() => resolve(enabled === true), 1500);
  });
  document.dispatchEvent(new Event('icd-inbox-merge-ask'));
  // inbox-gate.js가 늦게 뜨면 1.5초 뒤 Canvas 목록을 그대로 보여 준다.

  const inboxUrl = url => {
    let parsed;
    try { parsed = new URL(url, location.href); } catch { return null; }
    if (parsed.origin !== location.origin || parsed.pathname !== '/api/v1/conversations') return null;
    return (parsed.searchParams.get('scope') || 'inbox') === 'inbox' ? parsed : null;
  };

  const keyOf = url => {
    const key = new URL(url);
    for (const name of ['page', 'per_page', 'scope', '_']) key.searchParams.delete(name);
    key.searchParams.sort();
    return key.search;
  };

  // Canvas의 옛 날짜 라이브러리가 페이지의 Date.parse를 바꿔 숫자 대신 Date를 돌려준다. 생성자로 읽는다.
  const time = value => {
    if (typeof value !== 'string') return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  };

  // 답을 받은 적 없는 보낸 대화만 남긴다. 보관한 대화는 Canvas처럼 빼 둔다.
  const fetchSent = async (inbox, accept, signal) => {
    let url = new URL(inbox);
    url.searchParams.set('scope', 'sent');
    url.searchParams.delete('page');
    url.searchParams.set('per_page', '50');
    const items = [];
    const visited = new Set();
    while (url && !visited.has(url.href) && visited.size < 20) {
      visited.add(url.href);
      const response = await fetch(url.href, {
        credentials: 'same-origin',
        headers: accept ? { Accept: accept } : {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])
      });
      if (!response.ok) throw new Error(`Canvas API ${response.status}`);
      const data = JSON.parse((await response.text()).replace(PREFIX, ''));
      if (!Array.isArray(data)) throw new Error('보낸 목록 형식 오류');
      for (const item of data) {
        if (item && item.last_message_at == null && item.workflow_state !== 'archived' &&
            time(item.last_authored_message_at) !== null) items.push(item);
      }
      const next = response.headers.get('Link')?.split(',').find(part => /rel="?next"?/.test(part));
      const target = next?.match(/<([^>]+)>/)?.[1];
      url = target ? new URL(target, location.origin) : null;
      if (url && url.origin !== location.origin) throw new Error('다른 출처의 다음 페이지');
    }
    return items;
  };

  const prepare = async request => {
    if (!(await gate())) return null;
    const key = keyOf(request.url);
    if (Number(request.url.searchParams.get('page') || 1) <= 1) {
      drop();
      const controller = new AbortController();
      current = { key, controller, sent: fetchSent(request.url, request.accept, controller.signal), injected: new Set(), seen: new Set() };
    }
    // 첫 페이지를 우리가 보지 못한 목록이면 어디에 넣을지 몰라 손대지 않는다.
    const sequence = current;
    if (!sequence || sequence.key !== key) return null;
    try {
      const sent = await sequence.sent;
      return enabled && current === sequence ? { sequence, sent } : null;
    } catch { return null; }
  };

  // 이 페이지 가장 오래된 시각보다 새로운 보낸 대화를 시간 순서 자리에 넣는다. 마지막 페이지는 남은 것을 모두 넣는다.
  const merge = (text, context, hasNext) => {
    const prefix = text.match(PREFIX)?.[0] ?? '';
    const page = JSON.parse(text.slice(prefix.length));
    if (!Array.isArray(page)) return text;
    const { sequence, sent } = context;
    for (const item of page) sequence.seen.add(String(item.id));
    const times = page.map(item => time(item.last_message_at)).filter(value => value !== null);
    const floor = !hasNext ? -Infinity : times.length ? Math.min(...times) : Infinity;
    const extra = sent.filter(item => !sequence.injected.has(String(item.id)) && !sequence.seen.has(String(item.id)) &&
      time(item.last_authored_message_at) >= floor);
    // 마지막 페이지까지 넣었으면 보낸 목록을 들고 있지 않는다.
    if (!hasNext && current === sequence) current = null;
    if (!extra.length) return text;
    for (const item of extra) {
      sequence.injected.add(String(item.id));
      // 받은 편지함 행은 마지막 받은 메시지의 시각과 미리보기를 쓴다. 보낸 대화는 내가 보낸 것으로 채운다.
      const shown = { ...item, last_message_at: item.last_authored_message_at, last_message: item.last_message ?? item.last_authored_message };
      const at = time(shown.last_message_at);
      const index = page.findIndex(row => (time(row.last_message_at) ?? -Infinity) < at);
      page.splice(index < 0 ? page.length : index, 0, shown);
    }
    return prefix + JSON.stringify(page);
  };

  proto.open = function (method, url, ...rest) {
    // 같은 XHR을 다른 요청에 다시 쓰면 지난번에 붙인 응답 getter를 떼어 낸다.
    delete this.responseText;
    delete this.response;
    const target = String(method).toUpperCase() === 'GET' ? inboxUrl(url) : null;
    if (target) requests.set(this, { url: target, accept: '' });
    else requests.delete(this);
    return open.call(this, method, url, ...rest);
  };

  proto.setRequestHeader = function (name, value) {
    const request = requests.get(this);
    // Canvas는 Accept로 문자열 ID를 받는다. 보낸 목록도 같은 모양으로 받아야 한다.
    if (request && /^accept$/i.test(name)) request.accept = String(value);
    return setRequestHeader.call(this, name, value);
  };

  // 보내기 전에 취소하면 XHR은 열린 상태로 남는다. 미뤄 둔 send가 나가지 않게 기록을 지운다.
  proto.abort = function () {
    requests.delete(this);
    return abort.call(this);
  };

  proto.send = function (body) {
    const request = requests.get(this);
    if (!request) return send.call(this, body);
    const xhr = this;
    prepare(request).then(context => {
      // 기다리는 사이 Canvas가 취소했거나 같은 XHR로 다른 요청을 열었으면 보내지 않는다.
      if (requests.get(xhr) !== request || xhr.readyState !== 1) return;
      if (context && (xhr.responseType === '' || xhr.responseType === 'text')) {
        let merged;
        const read = () => {
          const text = textOf.call(xhr);
          if (xhr.readyState !== 4 || xhr.status !== 200 || requests.get(xhr) !== request || !enabled) return text;
          if (merged === undefined) {
            try { merged = merge(text, context, /rel="?next"?/.test(xhr.getResponseHeader('Link') || '')); } catch { merged = text; }
          }
          return merged;
        };
        Object.defineProperty(xhr, 'responseText', { configurable: true, get: read });
        Object.defineProperty(xhr, 'response', { configurable: true, get: read });
      }
      // 기다리는 사이 Canvas가 요청을 취소했으면 보내지 않는다.
      try { send.call(xhr, body); } catch { /* 취소된 요청 */ }
    });
  };
})();
