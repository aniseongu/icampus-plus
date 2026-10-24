// Runs only on LCMS pages. The playlist is controlled by the extension worker
// while the official iCampus lecture stays in the user's existing tab.
// Intro skip runs on every lecture. 2x, autoplay and dialog clicks run only
// for the playlist. Direct lectures keep the school's speed and play controls.
(async () => {
  const PLAYER_VERSION = chrome.runtime.getManifest().version;
  if (window.__icampusCheckPlayer) return;
  window.__icampusCheckPlayer = true;
  let examBlocked = true;
  const checkExam = async () => {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'exam-status' });
      if (typeof status?.guard !== 'boolean') throw new Error('시험 상태를 확인하지 못함');
      examBlocked = status.guard && (status.manual || status.examTabs > 0);
    } catch { examBlocked = true; }
  };
  await checkExam();

  // In a smaller window, expand a video or PDF inside Canvas. A maximized
  // window keeps the school's native fullscreen behavior.
  let theaterReady = false;
  let compactWindow = false;
  let theaterActive = false;
  if (window.top !== window && document.referrer.startsWith('https://canvas.skku.edu/')) {
    window.addEventListener('message', event => {
      if (event.origin !== 'https://canvas.skku.edu' || event.data?.type !== 'icd-theater-ready') return;
      theaterReady = true;
      compactWindow = event.data.compact === true;
      const wasActive = theaterActive;
      theaterActive = event.data.active === true;
      if (event.data.relayout === true || wasActive !== theaterActive) {
        // The video player and PDF viewer store pixel dimensions and
        // recalculate them only on resize.
        window.dispatchEvent(new Event('resize'));
      }
    });
    window.top.postMessage({ type: 'icd-theater-probe' }, 'https://canvas.skku.edu');
  }
  document.addEventListener('click', event => {
    if (examBlocked || !theaterReady) return;
    if (!(event.target instanceof Element) || !event.target.closest('.vc-pctrl-fullscreen-btn')) return;
    if (!document.querySelector('video, .player-mode-pdf')) return;
    if (!compactWindow && !theaterActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.top.postMessage({ type: 'icd-theater-toggle' }, 'https://canvas.skku.edu');
  }, true);
  document.addEventListener('keydown', event => {
    if (theaterActive && event.key === 'Escape') {
      window.top.postMessage({ type: 'icd-theater-close' }, 'https://canvas.skku.edu');
    }
  });

  const speedSources = new WeakMap();
  const speedAttempts = new WeakMap();
  let playlistKey = null;
  let directModeReady = false;
  let directTabMuted = false;
  let lastDirectInput = null;
  let directControlsTouched = false;
  let directFirstPlay = false;
  let directResetDefaults = false;
  const directMutedByUser = new WeakSet();
  const directRecovering = new WeakSet();
  const directMutePending = new WeakSet();
  let completionSent = false;
  let lastProgressSent = 0;
  let lastDialogClick = 0;
  let readyRequested = false;
  let lastReadyAt = 0;
  let rateTimer = null;
  const trackedVideos = new WeakSet();
  const trackedIntros = new WeakSet();
  const continuedIntroSources = new Set();
  const recoveringVideos = new WeakSet();
  const mutedFallbackVideos = new WeakSet();
  const soundRecoveryVideos = new WeakSet();
  let mutedFallbackReported = false;
  let soundOnReported = false;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'icampus-exam-blocked') {
      examBlocked = message.blocked === true;
      if (examBlocked) {
        playlistKey = null;
        directModeReady = false;
        readyRequested = false;
        mutedFallbackReported = false;
        soundOnReported = false;
      }
      else ready(true);
      return;
    }
    if (examBlocked) return;
    if (message?.type === 'icampus-playlist-probe') {
      sendResponse({ ok: true });
      if (!playlistKey) { readyRequested = false; ready(true); }
      return;
    }
    if (message?.type !== 'icampus-playlist-stop' || !playlistKey) return;
    playlistKey = null;
    completionSent = true;
    mutedFallbackReported = false;
    soundOnReported = false;
    try { video()?.pause(); } catch { /* The frame may already be navigating. */ }
  });

  function video() {
    const candidates = [...document.querySelectorAll('video')].filter(element => sourceOf(element));
    const visible = candidates.filter(element => element.getClientRects().length > 0);
    const lectures = candidates.filter(element => Number.isFinite(element.duration) && element.duration >= 10);
    // The official player hides its loaded main video behind the start screen.
    // An invisible video with a real source must still be eligible to start.
    return visible.find(element => lectures.includes(element) && element.readyState > 0) ||
      lectures.find(element => element.readyState > 0) ||
      visible.find(element => element.readyState > 0) || visible[0] ||
      candidates.find(element => element.readyState > 0) || candidates[0] || null;
  }

  function sourceOf(element) {
    return element?.currentSrc || element?.src || '';
  }

  function sendState(state) {
    if (!playlistKey) return;
    chrome.runtime.sendMessage({ type: 'icampus-player-state', key: playlistKey, state }).catch(() => {});
  }

  function reportMutedFallback(element) {
    mutedFallbackVideos.add(element);
    soundOnReported = false;
    if (mutedFallbackReported) return;
    mutedFallbackReported = true;
    sendState('muted-fallback');
  }

  function reportSoundOn(element) {
    mutedFallbackVideos.delete(element);
    mutedFallbackReported = false;
    if (soundOnReported) return;
    soundOnReported = true;
    sendState('sound-on');
  }

  async function playWithin(element) {
    let timeout;
    try {
      const playPromise = element.play();
      return await Promise.race([
        Promise.resolve(playPromise).then(() => true, () => false),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1200); })
      ]);
    } catch { return false; }
    finally { clearTimeout(timeout); }
  }

  // Silent means muted or volume 0. The school player's mute button sets volume 0.
  const silent = element => element.muted || element.volume === 0;
  const markPlaylistDefaultsDirty = () => {
    chrome.storage.local.set({ playerDefaultsDirty: true }).catch(() => {});
  };

  // Without a click (or the AutoplayAllowlist policy) Whale only autoplays a silent
  // video. Volume 0 keeps playing in a background tab; a muted video is paused there.
  // Either way the tab is not audible, so Whale may put it to sleep after a while (D-016).
  async function fallbackToMuted(element) {
    if (examBlocked || !playlistKey || !element.isConnected) return false;
    if (element.volume !== 0) markPlaylistDefaultsDirty();
    element.muted = false;
    element.volume = 0;
    reportMutedFallback(element);
    return await playWithin(element) && !element.paused;
  }

  async function restoreSoundOnInput(event) {
    if (!event.isTrusted || examBlocked || !playlistKey) return;
    const element = video();
    if (!element || !silent(element) || soundRecoveryVideos.has(element)) return;
    soundRecoveryVideos.add(element);
    let retryMuted = false;
    try {
      element.muted = false;
      if (element.volume !== 1) markPlaylistDefaultsDirty();
      element.volume = 1;
      let playing = element.paused ? await playWithin(element) : true;
      // The school player can pause just after its mute setting changes.
      if (playing) await new Promise(resolve => setTimeout(resolve, 1200));
      if (examBlocked || !playlistKey || !element.isConnected) return;
      if (playing && element.paused) {
        playing = await playWithin(element);
        if (playing) await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (!playing || element.paused || silent(element)) {
        await fallbackToMuted(element);
        retryMuted = element.paused;
      } else reportSoundOn(element);
    } finally {
      soundRecoveryVideos.delete(element);
      if (retryMuted) ensurePlayback(element);
    }
  }

  document.addEventListener('pointerdown', restoreSoundOnInput, true);
  document.addEventListener('keydown', restoreSoundOnInput, true);

  function noteDirectInput(event) {
    if (examBlocked || !event.isTrusted) return;
    const target = event.target;
    const slider = target.closest?.('.vc-pctrl-volume-slider, .vc-pctrl-volume-thumb');
    const control = target.closest?.('.vc-pctrl-volume-btn, button, [role="button"], [title], [aria-label]');
    const label = [control?.title, control?.getAttribute('aria-label')].filter(Boolean).join(' ');
    const muteButton = !slider && (control?.matches?.('.vc-pctrl-volume-btn') ||
      /^(?:음소거|mute|unmute|음소거 해제)$/i.test(label.trim()));
    const volumeControl = slider || target.closest?.('[class*="volume"]');
    const speedControl = target.closest?.('[class*="playback-rate"]');
    if (!muteButton && !volumeControl && !speedControl) return;
    if (!directFirstPlay) directControlsTouched = true;
    if (!muteButton && !volumeControl) return;
    lastDirectInput = { kind: muteButton ? 'button' : 'slider', at: Date.now() };
    // Pressing the player's mute button again means "sound on". The video is already
    // audible, so the player may not fire volumechange; unmute the tab ourselves.
    if (directTabMuted && !playlistKey) setTimeout(() => {
      const element = video();
      if (!directTabMuted || !element || silent(element) || examBlocked) return;
      chrome.runtime.sendMessage({ type: 'icampus-direct-mute', muted: false })
        .then(response => { if (typeof response?.muted === 'boolean') directTabMuted = response.muted; })
        .catch(() => {});
    }, 400);
  }
  document.addEventListener('pointerdown', noteDirectInput, true);
  document.addEventListener('keydown', noteDirectInput, true);

  async function restoreDirectSound(element) {
    if (!element || examBlocked || !directModeReady || playlistKey || isIntro(element) ||
        !element.muted || directMutedByUser.has(element) || directRecovering.has(element) ||
        !navigator.userActivation?.hasBeenActive) return;
    directRecovering.add(element);
    try {
      element.muted = false;
      await new Promise(resolve => setTimeout(resolve, 1200));
      if (examBlocked || !directModeReady || playlistKey || !element.isConnected ||
          directMutedByUser.has(element)) return;
      if (element.paused && !(await playWithin(element) && !element.paused)) element.muted = true;
    } finally { directRecovering.delete(element); }
  }

  async function handleDirectMute(event) {
    const element = event.target;
    if (!(element instanceof HTMLVideoElement) || examBlocked || !directModeReady || playlistKey ||
        isIntro(element) || element !== video() || directRecovering.has(element) ||
        !lastDirectInput || Date.now() - lastDirectInput.at > 1000 || directMutePending.has(element)) return;
    if (!silent(element)) {
      directMutedByUser.delete(element);
      if (directTabMuted) {
        chrome.runtime.sendMessage({ type: 'icampus-direct-mute', muted: false })
          .then(response => { if (typeof response?.muted === 'boolean') directTabMuted = response.muted; })
          .catch(() => {});
      }
      return;
    }
    if (lastDirectInput.kind !== 'button') return;
    if (element.paused) {
      directMutedByUser.add(element);
      return;
    }
    directMutePending.add(element);
    directMutedByUser.add(element);
    // Keep the video audible to Whale (no tab sleep) and silence the tab instead.
    element.muted = false;
    if (element.volume === 0) element.volume = 1;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'icampus-direct-mute', muted: !directTabMuted });
      if (typeof response?.muted === 'boolean') directTabMuted = response.muted;
      else if (!examBlocked) element.volume = 0;
      if (element.paused && !examBlocked) await playWithin(element);
    } catch { if (!examBlocked) element.volume = 0; }
    finally { directMutePending.delete(element); }
  }
  document.addEventListener('volumechange', handleDirectMute, true);
  // Reset only values that the previous playlist may have left behind.
  const directDefaulted = new WeakSet();
  function applyDirectDefaults(element) {
    if (!directModeReady || playlistKey || examBlocked || isIntro(element) ||
        !directResetDefaults || directControlsTouched || directDefaulted.has(element)) return;
    directDefaulted.add(element);
    if (element.playbackRate !== 1) element.playbackRate = 1;
    if (element.volume === 0) element.volume = 1;
    directResetDefaults = false;
    chrome.storage.local.set({ playerDefaultsDirty: false }).catch(() => {});
  }
  document.addEventListener('playing', event => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    applyDirectDefaults(event.target);
    if (directModeReady && !isIntro(event.target)) directFirstPlay = true;
    restoreDirectSound(event.target);
  }, true);

  function acceptPlayerDialog() {
    if (examBlocked) return false;
    if (!playlistKey || Date.now() - lastDialogClick < 750) return false;
    const dialog = [...document.querySelectorAll('#confirm-dialog, .confirm-dialog, [role="dialog"]')]
      .find(candidate => {
        const style = getComputedStyle(candidate);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (candidate.id === 'confirm-dialog' || candidate.classList.contains('confirm-dialog')) return true;
        return /보시겠습니까|이어|이전|확인|계속|재생|학습|종료/.test(candidate.textContent || '');
      });
    const buttons = dialog ? [...dialog.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')]
      .filter(button => !button.disabled && getComputedStyle(button).display !== 'none' &&
        getComputedStyle(button).visibility !== 'hidden') : [];
    const label = button => [button.textContent, button.value, button.title,
      button.getAttribute('aria-label')].filter(Boolean).join(' ').trim();
    const confirm = dialog?.querySelector('.confirm-ok-btn') || buttons.find(button =>
      /확인|예|이어|계속|재생|시작|OK/i.test(label(button)) &&
      !/취소|아니오|처음|닫기/.test(label(button)));
    if (!dialog || !confirm) return false;
    const dialogStyle = getComputedStyle(dialog);
    const confirmStyle = getComputedStyle(confirm);
    if (dialogStyle.display === 'none' || dialogStyle.visibility === 'hidden' ||
        confirmStyle.display === 'none' || confirmStyle.visibility === 'hidden') return false;
    lastDialogClick = Date.now();
    confirm.click();
    setTimeout(() => {
      const element = video();
      if (playlistKey && element) ensurePlayback(element);
    }, 150);
    return true;
  }

  function isIntro(element) {
    const source = sourceOf(element);
    return source.includes('/settings/viewer/uniplayer/intro') ||
      source.includes('/viewer/uniplayer/preloader.');
  }

  function continueIntro(element) {
    if (examBlocked) return false;
    if (!playlistKey || !isIntro(element)) return false;
    const source = sourceOf(element);
    if (!source || continuedIntroSources.has(source)) return false;
    continuedIntroSources.add(source);
    setTimeout(() => {
      if (examBlocked || !playlistKey || !isIntro(element) || sourceOf(element) !== source) return;
      const front = document.querySelector('#front-screen');
      const playButton = front?.querySelector('.vc-front-screen-play-btn');
      if (playButton) playButton.click();
      ensurePlayback(element);
    }, 100);
    return true;
  }

  // Jump to the intro's end instead of waiting it out (icampus-premium's
  // approach). The player then moves on to the lecture by itself.
  function skipIntro(element) {
    if (examBlocked) return;
    if (!isIntro(element)) return;
    const source = sourceOf(element);
    setTimeout(() => {
      if (examBlocked || !isIntro(element) || sourceOf(element) !== source) return;
      const end = element.duration;
      if (!Number.isFinite(end) || end <= 0 || element.currentTime >= end - .05) return;
      try { element.currentTime = end; } catch { /* Not seekable yet; a later event retries. */ }
    }, 100);
  }

  for (const type of ['loadedmetadata', 'durationchange', 'playing']) {
    document.addEventListener(type, event => {
      if (event.target instanceof HTMLVideoElement) skipIntro(event.target);
    }, true);
  }

  function watchIntro(element) {
    if (!element || trackedIntros.has(element)) return;
    trackedIntros.add(element);
    element.addEventListener('ended', () => continueIntro(element));
  }

  function rateButton() {
    return [...document.querySelectorAll('.vc-pctrl-playback-rate-btn, .vc-pctrl-playback-rate-setbox button, .vc-pctrl-playback-rate-setbox [role="menuitem"]')].find(button => {
      const label = [button.textContent, button.title, button.getAttribute('aria-label'), button.dataset.rate]
        .filter(Boolean).join(' ').trim();
      return /(?:^|[^\d])2(?:\.0)?\s*(?:x|×|배속|배)?(?:$|[^\d])/i.test(label);
    });
  }

  function applyTwoX(element) {
    if (examBlocked) return false;
    if (!element || isIntro(element)) return false;
    const source = sourceOf(element);
    if (!source) return false;
    if (element.playbackRate >= 1.99 && element.playbackRate <= 2.01) {
      speedSources.set(element, source);
      return true;
    }
    if (speedSources.get(element) === source) return false;
    const lastAttempt = speedAttempts.get(element);
    if (lastAttempt?.source === source && Date.now() - lastAttempt.time < 1000) return false;
    const button = rateButton();
    speedAttempts.set(element, { source, time: Date.now() });
    if (button) { markPlaylistDefaultsDirty(); button.click(); }
    else {
      const toggle = document.querySelector('.vc-pctrl-playback-rate-toggle-btn');
      if (!toggle) return false;
      markPlaylistDefaultsDirty();
      toggle.click();
      setTimeout(() => {
        if (examBlocked) return;
        const option = rateButton();
        if (option) option.click();
      }, 100);
    }
    setTimeout(() => {
      if (examBlocked) return;
      if (element.playbackRate >= 1.99 && element.playbackRate <= 2.01) {
        speedSources.set(element, source);
        sendState('speed-2x');
      }
    }, 600);
    return true;
  }

  function sendProgress(element, force = false) {
    if (examBlocked) return;
    if (!playlistKey || isIntro(element) || element !== video()) return;
    if (!force && Date.now() - lastProgressSent < 4000) return;
    lastProgressSent = Date.now();
    chrome.runtime.sendMessage({
      type: 'icampus-player-progress', key: playlistKey,
      currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      duration: Number.isFinite(element.duration) ? element.duration : 0,
      rate: element.playbackRate, paused: element.paused
    }).catch(() => {});
  }

  function watchProgress(element) {
    for (const event of ['play', 'pause', 'timeupdate', 'ratechange', 'loadedmetadata']) {
      element.addEventListener(event, () => sendProgress(element, event !== 'timeupdate'));
    }
    sendProgress(element, true);
  }

  function handleMedia(event) {
    if (examBlocked) return;
    if (!(event.target instanceof HTMLVideoElement) || event.target !== video()) return;
    if (isIntro(event.target)) watchIntro(event.target);
    if (!readyRequested) ready();
    if (playlistKey) {
      if (isIntro(event.target)) ensurePlayback(event.target);
      else attachVideo(event.target);
    }
  }

  document.addEventListener('loadedmetadata', handleMedia, true);
  document.addEventListener('durationchange', handleMedia, true);

  function completionVisible() {
    const button = document.querySelector('.player-restart-btn');
    if (!button) return false;
    const style = getComputedStyle(button);
    return style.display !== 'none' && style.visibility !== 'hidden' && button.getClientRects().length > 0;
  }

  function watchCompletion(element) {
    element.addEventListener('ended', () => {
      if (!playlistKey || completionSent) return;
      if (!Number.isFinite(element.duration) || element.duration < 10 ||
          element.currentTime < element.duration - 1) return;
      let checks = 0;
      const timer = setInterval(() => {
        if (!playlistKey) { clearInterval(timer); return; }
        acceptPlayerDialog();
        if (completionVisible()) {
          clearInterval(timer);
          completionSent = true;
          // This frame's playlist job is done. A replay here is the user's own,
          // so drop the key before any later video gets 2x or autoplay.
          const key = playlistKey;
          playlistKey = null;
          chrome.runtime.sendMessage({ type: 'icampus-player-ended', key }).catch(error => {
            if (!examBlocked) reportError('player', '재생목록의 다음 강의로 넘어가지 못했습니다.',
              { stack: error?.stack, url: location.href });
          });
        } else if (++checks >= 30) {
          clearInterval(timer);
          sendState('ended-unconfirmed');
        }
      }, 500);
    });
  }

  async function ensurePlayback(element) {
    if (examBlocked) return;
    if (recoveringVideos.has(element) || soundRecoveryVideos.has(element)) return;
    recoveringVideos.add(element);
    try {
      for (let attempt = 0; attempt < 4 && !examBlocked && playlistKey && element.isConnected; attempt++) {
        if (!element.paused && (!silent(element) || mutedFallbackVideos.has(element))) {
          if (!silent(element)) reportSoundOn(element);
          sendProgress(element, true);
          return;
        }
        const front = document.querySelector('#front-screen');
        const playButton = front?.querySelector('.vc-front-screen-play-btn');
        if (playButton && getComputedStyle(front).display !== 'none') playButton.click();
        // Play with sound while the worker keeps the tab muted: an audible tab is
        // neither paused nor put to sleep in the background (D-014, D-016).
        element.muted = false;
        if (element.volume === 0) { markPlaylistDefaultsDirty(); element.volume = 1; }
        const wasPlaying = !element.paused;
        const withSound = wasPlaying ? true : await playWithin(element);
        if (wasPlaying) await new Promise(resolve => setTimeout(resolve, 1200));
        if (soundRecoveryVideos.has(element) || examBlocked || !playlistKey) return;
        if (withSound && !element.paused) {
          reportSoundOn(element);
          sendProgress(element, true);
          return;
        }
        if (await fallbackToMuted(element)) { sendProgress(element, true); return; }
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (playlistKey && element.paused) sendState('autoplay-blocked');
    } finally {
      recoveringVideos.delete(element);
    }
  }

  function attachVideo(element) {
    if (!trackedVideos.has(element)) {
      trackedVideos.add(element);
      watchCompletion(element);
      watchProgress(element);
    }
    keepTwoX();
    ensurePlayback(element);
  }

  async function startPlaylist(response) {
    if (examBlocked) return;
    if (!response?.start || !response.key || response.rate > 2) return;
    directModeReady = false;
    playlistKey = response.key;
    mutedFallbackReported = false;
    soundOnReported = false;
    acceptPlayerDialog();
    const element = video();
    if (!element) return;
    if (isIntro(element)) {
      const onMainVideo = event => {
        if (!(event.target instanceof HTMLVideoElement) || isIntro(event.target)) return;
        document.removeEventListener('loadedmetadata', onMainVideo, true);
        attachVideo(event.target);
      };
      document.addEventListener('loadedmetadata', onMainVideo, true);
      watchIntro(element);
      ensurePlayback(element);
    } else {
      attachVideo(element);
    }
  }

  function ready(force = false) {
    if (examBlocked) return false;
    const element = video();
    if (!element) return false;
    if (readyRequested) return true;
    // A lecture opened outside the playlist gets a null answer; do not ask
    // again on every player mutation.
    if (!force && Date.now() - lastReadyAt < 1000) return true;
    lastReadyAt = Date.now();
    readyRequested = true;
    chrome.runtime.sendMessage({ type: 'icampus-player-ready', playerVersion: PLAYER_VERSION })
      .then(response => {
        if (examBlocked) { readyRequested = false; return; }
        if (response?.direct) {
          directModeReady = true;
          directTabMuted = response.muted === true;
          directResetDefaults = response.resetDefaults === true;
          if (video() && !video().paused) applyDirectDefaults(video());
          restoreDirectSound(video());
          return;
        }
        if (!response?.start) { readyRequested = false; return; }
        startPlaylist(response);
      }).catch(() => { readyRequested = false; });
    return true;
  }

  if (!ready()) {
    const observer = new MutationObserver(() => {
      ready();
      if (playlistKey) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
    setTimeout(() => observer.disconnect(), 60000);
  }

  // Retry the handshake when a frame loaded before the playlist worker was ready.
  let connectionChecks = 0;
  const connectionTimer = setInterval(() => {
    if (playlistKey || ++connectionChecks >= 60) { clearInterval(connectionTimer); return; }
    ready();
  }, 1000);

  // Retry a paused playlist video; tab mute normally keeps it playing in the background.
  setInterval(() => {
    if (examBlocked || !playlistKey) return;
    acceptPlayerDialog();
    const element = video();
    if (!element) return;
    if (isIntro(element)) {
      if (element.paused && Number.isFinite(element.duration) &&
          element.currentTime >= element.duration - .25) continueIntro(element);
      else if (element.paused) ensurePlayback(element);
      return;
    }
    if (element.paused && (!Number.isFinite(element.duration) ||
        element.currentTime < element.duration - 1)) ensurePlayback(element);
    else sendProgress(element);
  }, 5000);

  const dialogObserver = new MutationObserver(() => acceptPlayerDialog());
  dialogObserver.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class', 'aria-hidden']
  });

  // 2x is a playlist feature only. The school sometimes creates its rate menu
  // after the video element, so retry briefly once the playlist owns the video.
  function keepTwoX() {
    if (examBlocked || rateTimer || !playlistKey) return;
    let retries = 0;
    const stop = () => { clearInterval(rateTimer); rateTimer = null; };
    rateTimer = setInterval(() => {
      if (examBlocked || !playlistKey) { stop(); return; }
      const element = video();
      if (element && !isIntro(element)) {
        if (element.playbackRate >= 1.99 && element.playbackRate <= 2.01) {
          stop();
          sendState('speed-2x');
          return;
        }
        applyTwoX(element);
      }
      if (++retries >= 8) {
        stop();
        if (element && !isIntro(element)) {
          // Native media speed is a fallback if the school's menu changed.
          // Never set a rate above the school's stated 2x ceiling.
          try { markPlaylistDefaultsDirty(); element.playbackRate = 2; } catch { /* Restricted player. */ }
          if (element.playbackRate >= 1.99 && element.playbackRate <= 2.01) sendState('speed-2x');
          else sendState('speed-unavailable');
        }
      }
    }, 500);
    const element = video();
    if (element) applyTwoX(element);
  }

  // 영상 저장 (D-019). Only after the user turned it on in the popup, which grants
  // the optional permissions. The player's own content info lists the lecture
  // files, so no playback is needed: main alone, or main (camera, right) and
  // sub (screen, left) when the lecture was recorded as two videos.
  async function lectureMedia() {
    const id = location.pathname.match(/^\/em\/([0-9a-z]+)/i)?.[1];
    if (!id) return [];
    const response = await fetch('/viewer/ssplayer/uniplayer_support/content.php?content_id=' + encodeURIComponent(id),
      { credentials: 'include' });
    if (!response.ok) return [];
    const xml = new DOMParser().parseFromString(await response.text(), 'text/xml');
    const uri = name => xml.querySelector(name + ' > desktop > html5 > media_uri')?.textContent.trim() || '';
    const files = [['sub', uri('sub_media')], ['main', uri('main_media')]]
      .filter(([, url]) => /^https:\/\/[a-z0-9.-]+\.skku\.edu\/\S+\.mp4$/i.test(url));
    return files.map(([kind, url]) => ({ kind, url, label: files.length < 2 ? '강의' : kind === 'sub' ? '화면' : '카메라' }));
  }

  async function videoSaveEnabled() {
    if (examBlocked) return false;
    try { return (await chrome.runtime.sendMessage({ type: 'icampus-video-save-status' }))?.enabled === true; }
    catch { return false; }
  }

  const mediaFound = () => lectureMedia().then(media => ({ media, title: document.title }));

  // One icon in the control bar, just left of 전체화면, sized like its neighbours.
  async function setupVideoSave() {
    if (window.top === window || !/^\/em\//.test(location.pathname) || !globalThis.ICDVideoSave) return;
    if (!(await videoSaveEnabled())) return;
    // Look the files up once now, so a click starts the download at once; a
    // failed lookup is tried again on the click.
    let ready = mediaFound().catch(() => null);
    const getMedia = async () => (await ready)?.media?.length ? ready : (ready = mediaFound());
    const place = () => {
      const fullscreen = document.querySelector('.vc-pctrl-buttons-bar > .vc-pctrl-fullscreen-btn');
      if (!fullscreen || fullscreen.parentElement.querySelector('[data-icd-video-save]')) return Boolean(fullscreen);
      const host = document.createElement('div');
      host.dataset.icdVideoSave = '';
      host.style.cssText = 'float: right; height: 27px;';
      ICDVideoSave.mount(host, { getMedia });
      fullscreen.after(host);
      return true;
    };
    if (place()) return;
    const observer = new MutationObserver(() => { if (place()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 60000);
  }
  setupVideoSave();
})();
