// The native host owns a watchdog and releases its hook if the port disappears.
const FullscreenShield = (() => {
  const HOST = 'kr.aniseongu.icampus_fullscreen';
  let port = null;
  let phase = 'off';
  let generation = 0;
  let pending = null;

  async function announce() {
    chrome.runtime.sendMessage({ type: 'icampus-fullscreen-shield-change' }).catch(() => {});
    const tabs = await chrome.tabs.query({ url: 'https://canvas.skku.edu/*' });
    await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {
      type: 'icampus-fullscreen-shield', ready: phase === 'ready'
    }).catch(() => {})));
  }

  function setPhase(value) {
    if (phase === value) return;
    phase = value;
    announce().catch(() => {});
  }

  async function stop() {
    const old = port;
    ++generation;
    port = null;
    if (pending) { pending(false); pending = null; }
    setPhase(old ? 'stopping' : 'off');
    if (old) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(finish, 5000);
        old.onMessage.addListener(message => { if (message?.ok && message.active === false) finish(); });
        old.onDisconnect.addListener(finish);
        try { old.postMessage({ action: 'stop' }); } catch { finish(); }
      });
      try { old.disconnect(); } catch {}
    }
    setPhase('off');
  }

  async function start() {
    if (phase === 'ready') return true;
    if (phase === 'starting') return false;
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) {
      setPhase('permission');
      return false;
    }
    const id = ++generation;
    setPhase('starting');
    let current;
    try { current = chrome.runtime.connectNative(HOST); }
    catch { setPhase('error'); return false; }
    port = current;
    return new Promise(resolve => {
      let settled = false;
      const finish = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pending === finish) pending = null;
        resolve(ok);
      };
      pending = finish;
      const timer = setTimeout(() => {
        if (id !== generation) return finish(false);
        port = null;
        setPhase('error');
        try { current.disconnect(); } catch {}
        finish(false);
      }, 15000);
      current.onMessage.addListener(message => {
        if (id !== generation || current !== port) return;
        if (message?.ok && message.active === true) {
          setPhase('ready');
          finish(true);
        } else {
          port = null;
          setPhase('error');
          try { current.disconnect(); } catch {}
          finish(false);
        }
      });
      current.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (id !== generation || current !== port) return finish(false);
        port = null;
        setPhase('error');
        finish(false);
      });
      try { current.postMessage({ action: 'start' }); }
      catch {
        port = null;
        setPhase('error');
        try { current.disconnect(); } catch {}
        finish(false);
      }
    });
  }

  async function reconcile(active) {
    const saved = await chrome.storage.local.get(['examNoticeShield', 'examFullscreen', 'examGuard']);
    const wanted = saved.examNoticeShield === true && saved.examFullscreen !== false &&
      saved.examGuard !== false && active;
    if (!wanted) { await stop(); return false; }
    return start();
  }
  return { reconcile, stop, status: () => phase };
})();
