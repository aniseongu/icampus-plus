// 다크 모드 2층: 실행 중 <style>과 생성 시트에 없는 같은 출처 <link>의 색 선언을 transform.js 규칙대로 변환해
// 원본 시트마다 바로 뒤에 대응하는 icd-runtime 시트를 둔다. 정적 시트(sheets.css)가 못 보는, 실행 중에 만들어지는 규칙을 위한 층이다.
// - data-icd="on"일 때만 일한다. 꺼져 있으면 아무 것도 안 한다(icd-runtime의 규칙은 접두가 data-icd라 저절로 꺼진다).
// - styled-components는 insertRule로 규칙을 넣어 DOM이 안 바뀐다. 그래서 head의 childList를 보고, 유휴 시간에 시트마다 cssRules.length 변화를 확인한다
//   (변화가 없으면 확인 간격을 늘린다). 이미 본 규칙은 WeakSet으로 건너뛰므로 전체를 다시 훑어도 변환은 한 번만 한다.
// - 우리 시트(icd-*)와 확장 시트, sheets.css에 이미 담긴 링크 시트는 보지 않는다. adoptedStyleSheets는 문서 것만 본다.
(() => {
  const root = document.documentElement;
  const T = globalThis.ICDTransform;
  if (!T) return;
  let perfEnabled = location.search.includes('icdperf=') || /^icdperf-(light|dark)$/.test(window.name);
  try { perfEnabled ||= window.parent !== window && (window.parent.location.search.includes('icdperf=') || /^icdperf-(light|dark)$/.test(window.parent.name)); } catch (e) {}
  const perf = perfEnabled ? { scans: 0, rules: 0, converted: 0, ms: 0, firstMs: 0, polls: 0 } : null;
  const publishPerf = () => { if (perf) root.dataset.icdStylesPerf = JSON.stringify(perf); };

  const MIN_INTERVAL = 150;
  const MAX_INTERVAL = 4000;
  const SLICE_RULES = 300;
  const SLICE_MS = 8;
  // sheets.css 생성 시 사용한 두 시트. 해시가 달라지면 새 시트로 보고 실행 중 변환한다.
  const STATIC_SHEETS = new Set(['common-08dc185d29.css', 'login-172cde0ffb.css']);
  let sliceStart = 0;
  const seen = new WeakSet(); // 이미 변환을 시도한 CSSRule
  const lengths = new WeakMap(); // 시트 -> 마지막으로 본 cssRules.length
  const outputs = new WeakMap(); // 원본 시트 -> 원본 바로 뒤의 변환 시트
  let outputId = 0;
  let active = false;
  let timer = 0;
  let interval = MIN_INTERVAL;
  let scheduled = false;
  let queue = []; // {rules, index, target}
  let headObserver = null;

  function ensureSheet(source) {
    const previous = outputs.get(source);
    if (previous?.ownerNode?.isConnected) return previous;
    const el = document.createElement('style');
    el.id = `icd-runtime-${++outputId}`;
    const owner = source.ownerNode;
    if (owner?.isConnected) owner.after(el);
    else (document.head || root).appendChild(el); // adoptedStyleSheets에는 ownerNode가 없다
    outputs.set(source, el.sheet);
    return el.sheet;
  }

  const declsOf = (style) => {
    const decls = [];
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (prop.startsWith('--')) continue;
      decls.push({ prop, value: style.getPropertyValue(prop), important: style.getPropertyPriority(prop) === 'important' });
    }
    return decls;
  };

  function insert(target, rule) {
    try { target.insertRule(rule, target.cssRules.length); } catch (e) { /* 이 브라우저가 못 읽는 선택자는 건너뛴다 */ }
  }

  function convertStyleRule(rule, target) {
    // 배치·간격·글꼴만 있는 규칙은 색 변환의 대상이 아니다. 선택자 분해와 색 계산을 생략한다.
    let hasColor = false;
    for (let i = 0; i < rule.style.length; i++) {
      if (T.isColorProperty(rule.style[i])) { hasColor = true; break; }
    }
    if (!hasColor) return;
    const groups = T.convertSelectors(T.splitSelectors(rule.selectorText), declsOf(rule.style));
    for (const g of groups) {
      const body = g.decls.map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`).join('; ');
      insert(target, `${g.selectors.join(', ')} { ${body} }`);
      if (perf) perf.converted++;
    }
  }

  // 규칙 목록 일부를 처리한다. 반환: 처리한 규칙 수
  function processRules(rules, target, from, limit) {
    let n = 0;
    let i = from;
    for (; i < rules.length && n < limit; i++) {
      const rule = rules[i];
      if (seen.has(rule)) continue;
      seen.add(rule);
      n++;
      if (rule.type === CSSRule.STYLE_RULE) convertStyleRule(rule, target);
      else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE || (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule)) {
        // 조건 규칙의 안쪽도 별도 작업으로 나눠 처리한다. 큰 @media를 한 번에 재귀 처리하면 뒤쪽 규칙을 잃는다.
        const head = rule.type === CSSRule.MEDIA_RULE ? `@media ${rule.conditionText || rule.media.mediaText}` : rule.type === CSSRule.SUPPORTS_RULE ? `@supports ${rule.conditionText}` : `@container ${rule.conditionText}`;
        try {
          const index = target.insertRule(`${head} {}`, target.cssRules.length);
          queue.push({ rules: rule.cssRules, index: 0, target: target.cssRules[index] });
        } catch (e) { /* 조건을 못 읽으면 건너뜀 */ }
      }
      // 한 번에 8ms 넘게 붙잡지 않는다(긴 작업 방지). 남은 규칙은 다음 유휴 시간에 이어서 한다
      if (n % 20 === 0 && performance.now() - sliceStart > SLICE_MS) { i++; break; }
    }
    return { n, next: i };
  }

  function candidateSheets() {
    const list = [];
    for (const sheet of document.styleSheets) {
      const owner = sheet.ownerNode;
      if (!owner || sheet.disabled || (owner.id && owner.id.startsWith('icd-'))) continue;
      if (owner.tagName === 'LINK') {
        if (!sheet.href || new URL(sheet.href).origin !== location.origin) continue;
        if (STATIC_SHEETS.has(new URL(sheet.href).pathname.split('/').pop())) continue;
      } else if (owner.tagName !== 'STYLE') continue;
      list.push(sheet);
    }
    for (const sheet of document.adoptedStyleSheets || []) list.push(sheet);
    return list;
  }

  function collect() {
    let changed = false;
    for (const sheet of candidateSheets()) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (lengths.get(sheet) === rules.length && !queue.some((q) => q.rules === rules)) continue;
      lengths.set(sheet, rules.length);
      queue.push({ rules, index: 0, source: sheet });
      changed = true;
    }
    // 새 styled-components 시트를 큰 공통 시트 뒤에 오래 세워 두지 않는다.
    // 출력은 각 원본 시트 바로 뒤에 놓이므로 처리 순서가 바뀌어도 CSS 우선순위는 유지된다.
    if (changed) queue.sort((a, b) => a.rules.length - b.rules.length);
    return changed;
  }

  function work(deadline) {
    scheduled = false;
    if (!active) return;
    const begun = performance.now();
    sliceStart = begun;
    let budget = SLICE_RULES;
    while (queue.length && budget > 0) {
      const task = queue[0];
      const target = task.target || ensureSheet(task.source);
      if (!target) break;
      const { n, next } = processRules(task.rules, task.target || target, task.index, budget);
      budget -= Math.max(n, 1);
      task.index = next;
      if (perf) perf.rules += n;
      if (task.index >= task.rules.length) queue.shift();
      else break; // 이번 조각의 시간을 다 썼다. 나머지는 다음 유휴 시간에
    }
    if (perf) { perf.scans++; const d = performance.now() - begun; perf.ms += d; if (!perf.firstMs) perf.firstMs = d; publishPerf(); }
    if (queue.length) schedule();
  }

  function schedule() {
    if (scheduled || !active) return;
    scheduled = true;
    // LearningX는 큰 기본 시트 뒤에 화면별 규칙을 삽입한다. 500ms씩 기다리면 밝은 버튼이 수초간 남는다.
    // 각 작업은 8ms에서 끊으므로 짧은 유휴 기한으로 다음 조각을 빨리 이어 간다.
    if (typeof requestIdleCallback === 'function') requestIdleCallback(work, { timeout: 40 });
    else setTimeout(() => work(null), 0);
  }

  // 시트 길이 변화를 확인하는 점검. 변화가 없으면 간격을 늘리고, 있으면 처음 간격으로 되돌린다.
  function poll() {
    timer = 0;
    if (!active) return;
    if (perf) perf.polls++;
    if (collect()) { interval = MIN_INTERVAL; schedule(); }
    else interval = Math.min(MAX_INTERVAL, Math.round(interval * 1.6));
    if (!document.hidden) timer = setTimeout(poll, interval);
  }

  function kick() {
    if (!active) return;
    interval = MIN_INTERVAL;
    if (collect()) schedule();
    if (!timer && !document.hidden) timer = setTimeout(poll, interval);
  }

  function observeHead() {
    headObserver?.disconnect();
    headObserver = new MutationObserver(kick);
    // <head>의 자식 추가·삭제만 본다(속성이나 하위 트리는 보지 않는다). head가 아직 없으면 html의 자식을 본다
    headObserver.observe(document.head || root, { childList: true });
    if (!document.head) {
      const wait = new MutationObserver(() => { if (document.head) { wait.disconnect(); if (active) observeHead(); kick(); } });
      wait.observe(root, { childList: true });
    }
  }

  function start() {
    if (root.dataset.icd !== 'on') {
      stop();
      return;
    }
    if (active) return;
    active = true;
    observeHead();
    kick();
  }

  function stop() {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    timer = 0;
    headObserver?.disconnect();
    headObserver = null;
    queue = [];
    scheduled = false;
  }

  document.addEventListener('visibilitychange', () => { if (active && !document.hidden) kick(); });
  document.addEventListener('load', (event) => { if (event.target?.tagName === 'LINK') kick(); }, true);
  document.addEventListener('DOMContentLoaded', kick);
  new MutationObserver(start).observe(root, { attributes: true, attributeFilter: ['data-icd'] });
  start();
})();
