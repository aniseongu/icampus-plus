// Fullscreen is requested only from a real input on the top-level Canvas page.
(() => {
  if (window.top !== window) return;
  const EXAM_URL = /^https:\/\/canvas\.skku\.edu\/courses\/\d+\/quizzes\/\d+\/take(?:[/?#]|$)/;
  let guard = true;
  let manual = false;
  let fullscreen = true;
  let active = false;
  let fullscreenActive = false;
  let requestPending = false;
  let lockPending = false;
  let keyboardLocked = false;
  const countBlocked = () => {
    chrome.runtime.sendMessage({ type: 'icampus-exam-blocked-count' }).catch(() => {});
  };

  const blocksShortcut = event => {
    const { code, ctrlKey, metaKey, altKey, shiftKey } = event;
    if (code === 'F5' && !ctrlKey && !metaKey && !altKey && !shiftKey) return true;
    if (altKey && !ctrlKey && !metaKey) {
      return code === 'Tab' || (!shiftKey &&
        (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home'));
    }
    if (altKey || (!ctrlKey && !metaKey)) return false;
    if (metaKey && !ctrlKey) return code === 'KeyT' && !shiftKey;
    if (metaKey) return false;
    if (code === 'Tab' || code === 'KeyR' || code === 'KeyN' ||
        (code === 'KeyT' && shiftKey)) return true;
    if (shiftKey) return false;
    return code === 'KeyT' || code === 'KeyW' || code === 'F4' ||
      code === 'PageUp' || code === 'PageDown' ||
      /^Digit[1-9]$/.test(code) || /^Numpad[1-9]$/.test(code);
  };

  const blocksNewWindowLink = event => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const link = target?.closest('a[href]');
    if (!link) return false;
    const destination = link.getAttribute('target')?.toLowerCase();
    return (destination && !['_self', '_parent', '_top'].includes(destination)) ||
      event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1;
  };

  const unlock = () => {
    try { navigator.keyboard?.unlock?.(); } catch { /* Unsupported keyboard lock. */ }
    keyboardLocked = false;
    lockPending = false;
  };

  const lockKeyboard = () => {
    if (!fullscreenActive || keyboardLocked || lockPending || !navigator.keyboard?.lock) return;
    lockPending = true;
    try {
      Promise.resolve(navigator.keyboard.lock())
        .catch(() => navigator.keyboard.lock(['MetaLeft', 'MetaRight']))
        .then(() => {
          keyboardLocked = true;
          if (!fullscreenActive) unlock();
        })
        .catch(() => {})
        .finally(() => { lockPending = false; });
    } catch { lockPending = false; }
  };

  const onInput = () => {
    if (!fullscreenActive) return;
    if (document.fullscreenElement) {
      lockKeyboard();
      return;
    }
    if (requestPending) return;
    requestPending = true;
    try {
      // Call in the input handler before awaiting anything: fullscreen needs a user gesture.
      Promise.resolve(document.documentElement.requestFullscreen({ navigationUI: 'hide' }))
        .then(() => {
          if (fullscreenActive) lockKeyboard();
          else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        })
        .catch(() => {})
        .finally(() => { requestPending = false; });
    } catch { requestPending = false; }
  };

  const onFullscreenChange = () => {
    if (!document.fullscreenElement) unlock();
  };

  const onKeyDown = event => {
    if (fullscreenActive && document.fullscreenElement && blocksShortcut(event)) {
      event.preventDefault();
      if (!event.repeat) countBlocked();
    }
    onInput();
  };

  const onLinkClick = event => {
    if (!active || event.defaultPrevented || !blocksNewWindowLink(event)) return;
    event.preventDefault();
    countBlocked();
  };

  const sync = () => {
    const nextActive = guard && (manual || EXAM_URL.test(location.href));
    const nextFullscreen = nextActive && fullscreen;
    if (nextActive !== active) {
      active = nextActive;
      if (active) {
        window.addEventListener('click', onLinkClick, true);
        window.addEventListener('auxclick', onLinkClick, true);
      } else {
        window.removeEventListener('click', onLinkClick, true);
        window.removeEventListener('auxclick', onLinkClick, true);
      }
    }
    if (nextFullscreen === fullscreenActive) return;
    fullscreenActive = nextFullscreen;
    if (fullscreenActive) {
      window.addEventListener('pointerdown', onInput, true);
      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('fullscreenchange', onFullscreenChange);
    } else {
      window.removeEventListener('pointerdown', onInput, true);
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      unlock();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  };

  chrome.storage.local.get(['examGuard', 'examModeManual', 'examFullscreen']).then(saved => {
    guard = saved.examGuard !== false;
    manual = saved.examModeManual === true;
    fullscreen = saved.examFullscreen !== false;
    sync();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.examGuard) guard = changes.examGuard.newValue !== false;
    if (changes.examModeManual) manual = changes.examModeManual.newValue === true;
    if (changes.examFullscreen) fullscreen = changes.examFullscreen.newValue !== false;
    if (changes.examGuard || changes.examModeManual || changes.examFullscreen) sync();
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'icampus-exam-blocked') sync();
  });
})();
