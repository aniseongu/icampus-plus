// Canvas/LearningX의 인라인 색과 숨겨진 본문 글씨만 보정한다.
(() => {
  const root = document.documentElement;
  let perfEnabled = location.search.includes('icdperf=') || /^icdperf-(light|dark)$/.test(window.name);
  try { perfEnabled ||= window.parent !== window && (window.parent.location.search.includes('icdperf=') || /^icdperf-(light|dark)$/.test(window.parent.name)); } catch (e) {}
  const perf = perfEnabled ? { candidates: 0, processed: 0, firstScanMs: 0, totalMs: 0, observerMs: 0, flushMs: 0, netMs: 0, netVisited: 0, netHits: 0, netFixed: 0 } : null;
  if (perf) globalThis.__icdAdaptPerf = perf;
  const publishPerf = () => { if (perf) root.dataset.icdAdaptPerf = JSON.stringify(perf); };
  const color = globalThis.ICDColor;
  const selector = '[style*="color"], [style*="background"], [style*="border"], [style*="font-size"], [style*="opacity"], font[color], [bgcolor], .fc-event[class*="group_course_"], #context-list .context-list-toggle-box[class*="group_course_"]';
  const bodySelector = '.user_content, .description, .show-content, .discussion-section, [data-resource-type], .xn-content, .xnct-content';
  const skipSelector = '[contenteditable="true"], .tox, .mce-content-body';
  const accessibleSelector = '.screenreader-only, .sr-only, .screen-reader-only, [class*="ScreenReaderContent"], [class*="screen-reader"], [aria-hidden="false"]';
  const HIDDEN_CONTRAST = 1.25;
  const TITLE = '원래 보이지 않게 숨겨진 글씨입니다';
  const keys = new WeakMap();
  const marks = new WeakMap();
  const converted = new Map();
  const categorySources = new Map();
  const categoryKeys = new WeakMap();
  const pending = new Set();
  const hiddenPending = new Set();
  const work = [];
  const hiddenWork = [];
  const containerObservers = new Set();
  let seenContainers = new WeakSet();
  let darkBackgroundTokens;
  let offset = 0;
  let hiddenOffset = 0;
  let scheduled = false;
  let active = false;
  let generation = 0;

  function inputKey(el) {
    // 우리가 쓴 --icd-* 선언(인라인 보정은 --icd-inline-*)은 입력에서 제외한다. React가 원래 style을 바꾸면 키가 달라진다.
    const declarations = [];
    for (const name of el.style) {
      if (!name.startsWith('--icd-')) {
        declarations.push(`${name}:${el.style.getPropertyValue(name)}!${el.style.getPropertyPriority(name)}`);
      }
    }
    return `${declarations.join(';')}|${el.getAttribute('color') || ''}|${el.getAttribute('bgcolor') || ''}`;
  }

  function cached(kind, value, background) {
    if (!value || !color.parse(value)) return null;
    const key = `${kind}|${value}|${background ? color.format(background) : ''}`;
    if (!converted.has(key)) {
      converted.set(key, kind === 'text' ? color.text(value, background)
        : kind === 'background' ? color.background(value) : color.border(value));
    }
    return converted.get(key);
  }

  function tokenBackgrounds() {
    if (darkBackgroundTokens) return darkBackgroundTokens;
    darkBackgroundTokens = new Set();
    const style = getComputedStyle(root);
    for (const name of ['bg', 'surface', 'raised', 'hover', 'brand-soft',
      'table-header-bg', 'table-row-bg', 'table-row-zebra', 'table-row-hover',
      'table-row-selected', 'table-today-bg', 'table-dim-bg']) {
      const parsed = color.parse(style.getPropertyValue(`--icd-${name}`));
      if (parsed) darkBackgroundTokens.add(color.format(parsed));
    }
    return darkBackgroundTokens;
  }

  function originalBackground(el) {
    const container = el.closest(bodySelector);
    for (let node = el; node; node = node.parentElement) {
      const original = node.style.getPropertyValue('background-color') || node.getAttribute('bgcolor');
      const parsed = color.parse(original);
      if (parsed && parsed.a > 0) return parsed;
      // 다크 테마가 칠한 면만 건너뛴다. 배너처럼 원래 어두운 면은 그대로 믿는다.
      if (node !== el && marks.get(node)?.class) {
        if (!container || node === container) break;
        continue;
      }
      const computed = color.parse(getComputedStyle(node).backgroundColor);
      if (computed && computed.a > 0.5 && !tokenBackgrounds().has(color.format(computed))) return computed;
      if (!container || node === container) break;
    }
    return color.parse('#fff');
  }

  function darkBackground(el) {
    for (let node = el; node; node = node.parentElement) {
      const value = node.style.getPropertyValue('background-color') || node.getAttribute('bgcolor');
      const result = cached('background', value);
      if (result) return color.parse(result);
    }
    return color.SURFACE;
  }

  // 숨은 글씨는 인라인으로 글자색을 준 경우만 본다(흰 글씨 함정). 글자색 정보가 없으면 null을 돌려 대비 판정을 건너뛴다
  function originalText(el) {
    for (let node = el; node; node = node.parentElement) {
      const parsed = color.parse(node.style.getPropertyValue('color') || node.getAttribute('color'));
      if (parsed) return parsed;
    }
    return null;
  }

  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim()) return true;
    }
    return false;
  }

  function hidden(el) {
    if (el.closest(skipSelector) || el.closest(accessibleSelector) || !hasDirectText(el)) return null;
    if (!el.closest(bodySelector) && !(window !== window.top && el.closest('article, section'))) return null;
    const style = getComputedStyle(el);
    // 인라인 크기는 px일 때만 그대로 읽는다(1rem·1em을 1px로 읽던 오탐). 그 밖은 계산된 실제 크기로 본다
    const inlineSize = el.style.getPropertyValue('font-size');
    const small = parseFloat(/px$/.test(inlineSize) ? inlineSize : style.fontSize) <= 3;
    const faint = parseFloat(el.style.getPropertyValue('opacity') || style.opacity) <= 0.1;
    const original = originalText(el);
    const lowContrast = !!original && (original.a <= 0.1 || (() => {
      const background = originalBackground(el);
      return color.contrast(color.composite(original, background), background) < HIDDEN_CONTRAST;
    })());
    return small || faint || lowContrast ? { small, faint } : null;
  }

  function update(el, attr, variable, value, applied) {
    if (value) {
      el.style.setProperty(variable, value);
      el.setAttribute(attr, '');
      applied.push(variable);
    } else {
      el.style.removeProperty(variable);
      el.removeAttribute(attr);
    }
  }

  function updateMark(el, mark) {
    const owned = marks.get(el) || { class: false, title: false, small: false, faint: false };
    if (mark) {
      if (!el.classList.contains('icd-hidden-text')) {
        el.classList.add('icd-hidden-text');
        owned.class = true;
      }
      if (!el.hasAttribute('title')) {
        el.setAttribute('title', TITLE);
        owned.title = true;
      }
    } else {
      if (owned.class) el.classList.remove('icd-hidden-text');
      if (owned.title && el.getAttribute('title') === TITLE) el.removeAttribute('title');
      owned.class = false;
      owned.title = false;
    }
    for (const [kind, present] of [['small', !!mark?.small], ['faint', !!mark?.faint]]) {
      const attr = `data-icd-hidden-${kind}`;
      if (present && !el.hasAttribute(attr)) {
        el.setAttribute(attr, '');
        owned[kind] = true;
      } else if (!present && owned[kind]) {
        el.removeAttribute(attr);
        owned[kind] = false;
      }
    }
    if (owned.class || owned.title || owned.small || owned.faint) marks.set(el, owned);
    else marks.delete(el);
  }

  function recheckHidden(el) {
    if (root.dataset.icd !== 'on' || (!hasDirectText(el) && !marks.has(el))) return;
    // 표시용 CSS가 원래 배경·크기·투명도를 가리므로, 우리가 붙인 표지만 잠시 걷고 판정한다.
    const owned = marks.get(el);
    const removed = [];
    if (owned?.class && el.classList.contains('icd-hidden-text')) {
      el.classList.remove('icd-hidden-text');
      removed.push('class');
    }
    for (const kind of ['small', 'faint']) {
      const attr = `data-icd-hidden-${kind}`;
      if (owned?.[kind] && el.hasAttribute(attr)) {
        el.removeAttribute(attr);
        removed.push(attr);
      }
    }
    let mark;
    try {
      mark = hidden(el);
    } finally {
      for (const name of removed) {
        if (name === 'class') el.classList.add('icd-hidden-text');
        else el.setAttribute(name, '');
      }
    }
    updateMark(el, mark);
  }

  function adapt(el) {
    if (root.dataset.icd !== 'on' || el.closest(skipSelector)) return;
    const group = /\bgroup_course_\d+\b/.exec(el.className || '');
    if (group && (el.matches('.fc-event') || el.matches('#context-list .context-list-toggle-box'))) {
      const key = group[0];
      let original = categorySources.get(key);
      if (!original) {
        const legend = document.querySelector(`#context-list .context-list-toggle-box.${key}`);
        original = legend && getComputedStyle(legend).color;
        if (original) categorySources.set(key, original);
      }
      if (original && categoryKeys.get(el) !== original) {
        const shade = color.category(original);
        if (shade) {
          el.style.setProperty('--icd-category-bg', shade.background);
          el.style.setProperty('--icd-category-fg', shade.foreground);
          el.style.setProperty('--icd-category-line', shade.border);
          el.setAttribute('data-icd-category', '');
          categoryKeys.set(el, original);
        }
      }
    }
    const key = inputKey(el);
    const previous = keys.get(el);
    recheckHidden(el);
    if (previous?.key === key && previous.applied.every(name => el.style.getPropertyValue(name))) return;

    const applied = [];
    const originalBg = el.style.getPropertyValue('background-color') || el.getAttribute('bgcolor');
    const bg = cached('background', originalBg);
    update(el, 'data-icd-bg', '--icd-inline-bg', bg, applied);

    const originalColor = el.style.getPropertyValue('color') || el.getAttribute('color');
    const textBg = bg ? color.parse(bg) : darkBackground(el);
    update(el, 'data-icd-c', '--icd-inline-c', cached('text', originalColor, textBg), applied);

    let hasBorder = false;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const name = `--icd-inline-bd-${side}`;
      const value = cached('border', el.style.getPropertyValue(`border-${side}-color`));
      if (value) {
        el.style.setProperty(name, value);
        applied.push(name);
        hasBorder = true;
      } else el.style.removeProperty(name);
    }
    if (hasBorder) el.setAttribute('data-icd-bd', '');
    else el.removeAttribute('data-icd-bd');

    keys.set(el, { key, applied });
  }

  function addCandidates(node) {
    if (node.nodeType !== 1) return;
    if (node.matches(selector)) work.push(node);
    work.push(...node.querySelectorAll(selector));
  }

  function queueHidden(node) {
    if (node.nodeType !== 1 || (!node.closest(bodySelector) && !seenContainers.has(node))) return;
    hiddenPending.add(node);
    schedule();
  }

  function classKey(value) {
    return String(value || '').split(/\s+/).filter(name => name && name !== 'icd-hidden-text').sort().join(' ');
  }

  function watchContainer(container) {
    if (seenContainers.has(container)) return;
    seenContainers.add(container);
    const observer = new MutationObserver((records) => {
      const begun = perf && performance.now();
      if (!active) return;
      for (const record of records) {
        if (record.attributeName === 'class' && classKey(record.oldValue) === classKey(record.target.getAttribute('class'))) continue;
        if (record.attributeName === 'style' && keys.get(record.target)?.key === inputKey(record.target)) continue;
        queueHidden(record.target);
      }
      if (perf) { perf.observerMs += performance.now() - begun; publishPerf(); }
    });
    observer.observe(container, { attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style'], subtree: true });
    containerObservers.add(observer);
    hiddenPending.add(container);
  }

  function discoverContainers(node) {
    if (node.matches(bodySelector)) watchContainer(node);
    for (const container of node.querySelectorAll(bodySelector)) watchContainer(container);
  }


  // 안전망: CSS 규칙이 놓친 "큰 밝은 상자"를 실행 중에 찾아 어둡게 한다(규칙은 방문한 화면에서만 검증되므로, 못 본 화면의 흰 상자를 막는 마지막 층).
  // 블록 요소만 TreeWalker로 훑고(폭 120px, 높이 40px 이상, 자기 배경이 불투명하고 밝은 것), 우리 토큰 색이거나 이미지·전역 메뉴·편집기 안은 건드리지 않는다.
  // 요소마다 한 번만 보고(WeakSet), 숨은 요소는 보류했다가 클릭 뒤 다시 훑는다. 속성 감시는 추가하지 않는다.
  const NET_MIN_W = 120;
  const NET_MIN_H = 40;
  const NET_FIX_LIMIT = 150;
  const netSkipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'LINK', 'META', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'PICTURE', 'OBJECT', 'EMBED', 'svg', 'SVG']);
  const netSkipSelector = `${skipSelector}, #header, .ic-avatar`;
  const netChecked = new WeakSet();
  const netPending = new Set();
  const netTasks = [];
  const netFilter = {
    // 이미 그려졌고 120×40보다 작은 요소는 안쪽도 그보다 작으므로 하위 트리째 건너뛴다(글자 조각이 대부분이라 방문 수가 크게 준다)
    acceptNode: (node) => {
      if (netSkipTags.has(node.tagName) || node.matches(netSkipSelector)) return NodeFilter.FILTER_REJECT;
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      return (w || h) && (w < NET_MIN_W || h < NET_MIN_H) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  };

  function netInspect(el, hits) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!w && !h) return; // 숨은 요소는 표시된 뒤에 다시 본다
    netChecked.add(el);
    if (w < NET_MIN_W || h < NET_MIN_H) return;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage !== 'none') return;
    const bg = color.parse(cs.backgroundColor);
    if (!bg || bg.a < 0.9 || color.luminance(bg) <= 0.5) return;
    if (tokenBackgrounds().has(color.format(bg))) return;
    hits.push({ el, bg: cs.backgroundColor });
  }

  function netLightLine(cs) {
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (cs[`border${side}Style`] === 'none' || parseFloat(cs[`border${side}Width`]) < 0.5) continue;
      const c = color.parse(cs[`border${side}Color`]);
      if (c && c.a > 0.3 && color.luminance(c) > 0.33) return true;
    }
    return false;
  }

  // 새 면 안쪽: 대비가 모자란 글자와 밝은 테두리를 고친다. 자기 배경(색·그림)이 있는 하위 요소는 그 안쪽을 건드리지 않는다.
  function netFixInside(parent, newBg, budget) {
    for (const node of parent.children) {
      if (budget.n <= 0) return;
      if (netSkipTags.has(node.tagName) || node.matches(netSkipSelector)) continue;
      budget.n--;
      const cs = getComputedStyle(node);
      if (cs.display === 'none') continue;
      if (netLightLine(cs)) { node.setAttribute('data-icd-auto-line', ''); budget.fixed++; }
      const own = color.parse(cs.backgroundColor);
      if ((own && own.a > 0.5) || cs.backgroundImage !== 'none') continue;
      if (hasDirectText(node)) {
        const fg = color.parse(cs.color);
        if (fg && color.contrast(color.composite(fg, newBg), newBg) < 4.5) {
          const fixed = cached('text', cs.color, newBg);
          if (fixed) {
            node.style.setProperty('--icd-auto-c', fixed);
            node.setAttribute('data-icd-auto-c', '');
            budget.fixed++;
          }
        }
      }
      netFixInside(node, newBg, budget);
    }
  }

  function netApply({ el, bg }) {
    const dark = cached('background', bg);
    if (!dark) return;
    el.style.setProperty('--icd-auto-bg', dark);
    el.setAttribute('data-icd-auto-bg', '');
    if (netLightLine(getComputedStyle(el))) el.setAttribute('data-icd-auto-line', '');
    const budget = { n: NET_FIX_LIMIT, fixed: 0 };
    netFixInside(el, color.parse(dark), budget);
    if (perf) { perf.netHits++; perf.netFixed += budget.fixed; }
  }

  function netRun(deadline) {
    const begun = performance.now();
    const hits = [];
    let visited = 0;
    while (netTasks.length) {
      const task = netTasks[0];
      const el = task.node;
      if (!el) { netTasks.shift(); continue; }
      task.node = task.walker.nextNode();
      visited++;
      if (el.isConnected && !netChecked.has(el)) netInspect(el, hits);
      if (visited >= 400 || (visited % 50 === 0 && (deadline ? deadline.timeRemaining() < 1 : performance.now() - begun > 8))) break;
    }
    for (const hit of hits) netApply(hit);
    if (perf) { perf.netMs += performance.now() - begun; perf.netVisited += visited; }
  }

  function netQueue(node) {
    if (node.nodeType !== 1 || netSkipTags.has(node.tagName)) return;
    netPending.add(node);
  }

  // 메뉴·모달처럼 클릭으로 나타나는 면은 DOM 추가 없이 보일 수 있다. 클릭 뒤 한 번 다시 훑는다(이미 본 요소는 건너뛴다).
  let netClickTimer = 0;
  document.addEventListener('click', () => {
    if (!active) return;
    clearTimeout(netClickTimer);
    netClickTimer = setTimeout(() => {
      if (active && document.body) { netQueue(document.body); schedule(); }
    }, 300);
  }, { capture: true, passive: true });

  function schedule() {
    if (scheduled || !active) return;
    scheduled = true;
    const current = generation;
    const run = (deadline) => {
      if (current === generation) flush(deadline);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 300 });
    else setTimeout(() => run(null), 0);
  }

  function flush(deadline) {
    const begun = perf && performance.now();
    scheduled = false;
    if (!active) return;
    for (const node of pending) addCandidates(node);
    pending.clear();
    for (const node of hiddenPending) {
      if (node.isConnected) hiddenWork.push({ walker: document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT), node });
    }
    hiddenPending.clear();
    for (const node of netPending) {
      if (node.isConnected) netTasks.push({ walker: document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, netFilter), node });
    }
    netPending.clear();
    let processed = 0;
    const hasTime = () => deadline ? (processed === 0 || deadline.timeRemaining() > 0) : processed < 50;
    while (offset < work.length && hasTime()) {
      const el = work[offset++];
      if (el.isConnected) adapt(el);
      processed++;
      if (perf) perf.processed++;
    }
    if (offset === work.length) {
      work.length = 0;
      offset = 0;
    }
    while (hiddenOffset < hiddenWork.length && hasTime()) {
      const task = hiddenWork[hiddenOffset];
      if (task.node.isConnected) recheckHidden(task.node);
      task.node = task.walker.nextNode();
      if (!task.node) hiddenOffset++;
      processed++;
      if (perf) perf.processed++;
    }
    if (hiddenOffset === hiddenWork.length) {
      hiddenWork.length = 0;
      hiddenOffset = 0;
    }
    if (netTasks.length) netRun(deadline);
    if (work.length || hiddenWork.length || pending.size || hiddenPending.size || netTasks.length || netPending.size) schedule();
    if (perf) { perf.flushMs += performance.now() - begun; perf.totalMs = performance.now() - perf.started; publishPerf(); }
  }

  function queue(node, added = false) {
    if (node.nodeType !== 1) return;
    pending.add(node);
    if (added) { discoverContainers(node); netQueue(node); }
    queueHidden(node);
    schedule();
  }

  const bodyObserver = new MutationObserver((records) => {
    const begun = perf && performance.now();
    if (!active) return;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (keys.get(record.target)?.key !== inputKey(record.target)) queue(record.target);
      }
      else {
        for (const node of record.addedNodes) queue(node, true);
        queueHidden(record.target);
      }
    }
    if (perf) { perf.observerMs += performance.now() - begun; publishPerf(); }
  });

  function stop() {
    if (!active) return;
    active = false;
    generation++;
    bodyObserver.disconnect();
    for (const observer of containerObservers) observer.disconnect();
    containerObservers.clear();
    seenContainers = new WeakSet();
    pending.clear();
    hiddenPending.clear();
    netPending.clear();
    netTasks.length = 0;
    work.length = 0;
    hiddenWork.length = 0;
    offset = 0;
    hiddenOffset = 0;
    scheduled = false;
  }

  function start() {
    if (root.dataset.icd !== 'on') {
      stop();
      return;
    }
    if (active) return;
    active = true;
    if (perf) { perf.started = performance.now(); performance.mark('icd-adapt-start'); }
    bodyObserver.observe(root, { childList: true, attributes: true, attributeFilter: ['style', 'color', 'bgcolor'], subtree: true });
    discoverContainers(root);
    if (document.body) netQueue(document.body);
    // 켤 때마다 현재 DOM을 다시 훑되, 기존 입력 키의 색 변환은 건너뛴다.
    work.push(...document.querySelectorAll(selector));
    if (perf) { perf.candidates = work.length; perf.firstScanMs = performance.now() - perf.started; performance.mark('icd-adapt-first-scan'); performance.measure('icd-adapt-first-scan', 'icd-adapt-start', 'icd-adapt-first-scan'); publishPerf(); }
    schedule();
  }

  new MutationObserver(start).observe(root, { attributes: true, attributeFilter: ['data-icd'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
