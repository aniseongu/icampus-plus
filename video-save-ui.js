// 영상 저장 button (D-019) in the LCMS player's control bar (player.js).
// Icon only, like the player's own controls. The icon is Lucide "download"
// (ISC license, lucide.dev); its check icon confirms a started download.
// Everything lives in a closed shadow root so neither the school's styles nor
// the dark-mode color pass (dark/adapt.js) can restyle it.
globalThis.ICDVideoSave = globalThis.ICDVideoSave || (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DOWNLOAD = ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5'];
  const CHECK = ['M20 6 9 17l-5-5'];

  function icon(paths, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true' })) svg.setAttribute(name, value);
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  // White on the player's dark bar, sized like its neighbours (30x27, 6px side
  // padding); the two-file menu opens above the button.
  // errlog.js (loaded first in this frame) files the reason when the error log is on.
  function logFailure(message) {
    // eslint-disable-next-line no-undef
    try { if (typeof ErrorLog !== 'undefined') ErrorLog.reportError('player', message, { url: location.origin + location.pathname }); }
    catch { /* Logging is optional. */ }
  }

  function mount(host, { getMedia }) {
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { position: relative; display: inline-block; vertical-align: middle; }
      button.save { display: flex; align-items: center; justify-content: center; width: 42px; height: 27px;
        padding: 0; border: 0; border-radius: 6px; background: transparent; color: #fff; cursor: pointer; }
      button.save:hover { background: rgba(255, 255, 255, .14); }
      button.save:focus-visible, .menu button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
      button.save:disabled { cursor: default; opacity: .6; }
      .menu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 2147483647; min-width: 96px;
        padding: 4px; border-radius: 8px; background: rgba(20, 20, 20, .94); border: 1px solid rgba(255, 255, 255, .16);
        box-shadow: 0 4px 12px rgba(0, 0, 0, .25); }
      .menu[hidden] { display: none; }
      .menu button { display: block; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px; text-align: left;
        background: transparent; color: #fff; font: 500 13px/1.4 "Pretendard", system-ui, sans-serif;
        white-space: nowrap; cursor: pointer; }
      .menu button:hover { background: rgba(255, 255, 255, .14); }`;
    const button = document.createElement('button');
    button.className = 'save';
    button.type = 'button';
    button.title = '다운로드';
    button.setAttribute('aria-label', '강의 영상 다운로드');
    button.append(icon(DOWNLOAD, 18));
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    root.append(style, button, menu);

    let resetTimer = null;
    function show(paths, text) {
      button.replaceChildren(icon(paths, 18));
      button.title = text;
      button.setAttribute('aria-label', text);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        button.replaceChildren(icon(DOWNLOAD, 18));
        button.title = '다운로드';
        button.setAttribute('aria-label', '강의 영상 다운로드');
      }, 2500);
    }

    async function save(item, title) {
      menu.hidden = true;
      button.disabled = true;
      let response = null;
      try { response = await chrome.runtime.sendMessage({ type: 'icampus-video-save', media: [item], title }); }
      catch { /* Reported below. */ }
      button.disabled = false;
      if (response?.ok) show(CHECK, '다운로드를 시작했어요');
      else {
        show(DOWNLOAD, !response ? '강의 화면을 새로고침한 뒤 다시 눌러 주세요' : '다운로드하지 못했어요. 다시 눌러 주세요');
        logFailure('영상 저장 실패: ' + (response?.error || '워커 응답 없음'));
      }
    }

    // The LCMS player swallows the mouse events that follow a press, so no
    // click ever reaches the bar (seen 2026-10-19: pointerdown and pointerup
    // arrive, mousedown and click do not). Act on pointerup after a press on
    // the same control; keyboard activation still comes as a click (detail 0).
    function onActivate(control, handler) {
      let pressed = false;
      control.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        pressed = true;
        event.stopPropagation();
      });
      control.addEventListener('pointerup', event => {
        if (!pressed || event.button !== 0) return;
        pressed = false;
        event.stopPropagation();
        handler();
      });
      control.addEventListener('pointerleave', () => { pressed = false; });
      control.addEventListener('click', event => {
        event.stopPropagation();
        if (event.detail === 0) handler();
      });
    }

    onActivate(button, async () => {
      if (!menu.hidden) { menu.hidden = true; return; }
      let found = null;
      try { found = await getMedia(); } catch { /* Reported below. */ }
      const media = found?.media || [];
      if (!media.length) {
        show(DOWNLOAD, '강의 영상을 찾지 못했어요. 새로고침해 주세요');
        logFailure('영상 저장: 강의 영상 주소를 찾지 못함');
        return;
      }
      if (media.length === 1) { save(media[0], found.title); return; }
      // Two files (screen and camera recorded separately): pick one.
      menu.replaceChildren(...media.map(item => {
        const option = document.createElement('button');
        option.type = 'button';
        option.setAttribute('role', 'menuitem');
        option.textContent = item.label + ' 영상';
        onActivate(option, () => save(item, found.title));
        return option;
      }));
      menu.hidden = false;
      menu.querySelector('button')?.focus();
    });
    root.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.hidden = true; button.focus(); } });
    // A press anywhere outside the icon and its menu closes the menu.
    document.addEventListener('pointerdown', event => {
      if (!event.composedPath().includes(host)) menu.hidden = true;
    }, true);
    return { button };
  }

  return { mount };
})();
