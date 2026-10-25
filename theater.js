// Expand a LearningX video or PDF inside a smaller Whale window.
(() => {
  if (!/^\/courses\/\d+\/modules\/items\/\d+/.test(location.pathname)) return;

  let frame = null;
  let savedFrameStyle = null;
  let savedWrapperStyle = null;
  let savedPlayerStyle = null;
  let savedPlayerContainerStyle = null;
  let playerFrame = null;
  let playerContainer = null;
  let mainStyle = null;
  let observer = null;
  let expiry = 0;
  const watchedFrames = new WeakSet();
  const watchedDocuments = new WeakSet();

  function compactWindow() {
    return innerWidth < screen.availWidth - 20 || innerHeight < screen.availHeight - 100;
  }

  function sendState(player, relayout = false) {
    player?.postMessage({ type: 'icd-theater-ready', compact: compactWindow(), active: savedFrameStyle !== null, relayout }, 'https://lcms.skku.edu');
  }

  function lcmsWindow() {
    return frame?.contentDocument?.querySelector('iframe[src^="https://lcms.skku.edu/"]')?.contentWindow;
  }

  // Canvas sizes the tool wrapper, LearningX the player container and LCMS
  // its video only on their own window's resize. Expanding or closing changes
  // just the frame, so a window resized meanwhile leaves stale sizes. Ask each
  // layer to measure again, outermost first.
  function relayout() {
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => {
      frame?.contentWindow?.dispatchEvent(new Event('resize'));
      setTimeout(() => sendState(lcmsWindow(), true), 100);
    }, 100);
  }

  function close() {
    if (!frame || savedFrameStyle === null) return;
    const wrapper = frame.closest('.tool_content_wrapper');
    if (playerFrame && savedPlayerStyle !== null) {
      playerFrame.classList.remove('icd-theater-player-frame');
      playerFrame.style.cssText = savedPlayerStyle;
    }
    if (playerContainer && savedPlayerContainerStyle !== null) {
      playerContainer.classList.remove('icd-theater-player');
      playerContainer.style.cssText = savedPlayerContainerStyle;
    }
    playerFrame = null;
    playerContainer = null;
    savedPlayerStyle = null;
    savedPlayerContainerStyle = null;
    frame.style.cssText = savedFrameStyle;
    savedFrameStyle = null;
    if (wrapper && savedWrapperStyle !== null) {
      wrapper.classList.remove('icd-theater-wrapper');
      wrapper.style.cssText = savedWrapperStyle;
    }
    document.documentElement.classList.remove('icd-theater-active');
    savedWrapperStyle = null;
    const main = document.querySelector('#main');
    if (main && mainStyle !== null) main.style.cssText = mainStyle;
    mainStyle = null;
    sendState(lcmsWindow());
    relayout();
  }

  function toggle() {
    if (savedFrameStyle !== null) { close(); return; }
    if (!frame?.isConnected) return;
    const wrapper = frame.closest('.tool_content_wrapper');
    if (!wrapper) return;
    savedFrameStyle = frame.style.cssText;
    savedWrapperStyle = wrapper.style.cssText;
    const main = document.querySelector('#main');
    if (main) {
      // Canvas's global navigation sits above #main in a separate stacking context.
      mainStyle = main.style.cssText;
      main.style.position = 'relative';
      main.style.zIndex = '2147483645';
    }
    Object.assign(wrapper.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      maxWidth: 'none', maxHeight: 'none', zIndex: '2147483646',
      backgroundColor: document.documentElement.dataset.icd === 'on' ? '#000' : '#fff',
    });
    wrapper.classList.add('icd-theater-wrapper');
    document.documentElement.classList.add('icd-theater-active');
    frame.style.width = '100%';
    frame.style.height = '100%';
    // LearningX wraps video and PDF frames separately. Give their LCMS frame
    // the viewport rather than leaving it under the lecture metadata.
    playerFrame = frame.contentDocument?.querySelector('iframe[src^="https://lcms.skku.edu/"]') || null;
    playerContainer = playerFrame?.closest('.xnlailvc-commons-container, .xnpc-commons-container') || null;
    if (playerContainer) {
      savedPlayerStyle = playerFrame.style.cssText;
      savedPlayerContainerStyle = playerContainer.style.cssText;
      playerContainer.classList.add('icd-theater-player');
      playerFrame.classList.add('icd-theater-player-frame');
    }
    relayout();
  }

  window.addEventListener('message', event => {
    if (event.origin !== 'https://lcms.skku.edu' || !['icd-theater-probe', 'icd-theater-toggle', 'icd-theater-close'].includes(event.data?.type)) return;
    if (!place()) return;
    if (event.source !== lcmsWindow()) return;
    if (event.data.type === 'icd-theater-probe') sendState(event.source);
    else {
      if (event.data.type === 'icd-theater-close') close();
      else toggle();
      sendState(event.source);
    }
  });

  function place() {
    frame = document.querySelector('#tool_content.tool_launch');
    if (!frame) return false;
    if (!watchedFrames.has(frame)) {
      watchedFrames.add(frame);
      frame.addEventListener('load', () => {
        if (place()) { observer?.disconnect(); clearTimeout(expiry); }
      });
    }
    if (!/\/learningx\/lti\/lecture_attendance\/items\/view\//.test((() => {
      try { return frame.contentWindow.location.pathname; }
      catch { /* 다른 출처 프레임의 주소는 읽을 수 없다. */ return ''; }
    })())) return false;
    if (!frame.closest('.tool_content_wrapper')) return false;
    if (!watchedDocuments.has(frame.contentDocument)) {
      watchedDocuments.add(frame.contentDocument);
      frame.contentDocument.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
      });
    }
    return true;
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && savedFrameStyle !== null) close();
  });
  window.addEventListener('resize', () => sendState(lcmsWindow()));

  if (place()) return;
  observer = new MutationObserver(() => { if (place()) { observer.disconnect(); clearTimeout(expiry); } });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  expiry = setTimeout(() => observer.disconnect(), 15000);
  window.addEventListener('load', () => { if (place()) { observer.disconnect(); clearTimeout(expiry); } }, { once: true });
})();
