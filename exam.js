// Shared by the service worker and popup. Keep the URL rule in sync with dark/boot.js.
const ExamMode = (() => {
  const EXAM_URL = /^https:\/\/canvas\.skku\.edu\/courses\/\d+\/quizzes\/\d+\/take(?:[/?#]|$)/;
  const IDS_KEY = 'examDisabledIds';

  async function disabledIds() {
    const saved = await chrome.storage.local.get(IDS_KEY);
    return Array.isArray(saved[IDS_KEY]) ? saved[IDS_KEY].filter(id => typeof id === 'string') : [];
  }

  async function blockNotifications() {
    const allowed = await chrome.permissions.contains({ permissions: ['contentSettings'] });
    if (!allowed) return false;
    try {
      await chrome.contentSettings.notifications.set({ primaryPattern: '<all_urls>', setting: 'block' });
      await chrome.storage.local.set({ examNotificationsBlocked: true });
      return true;
    } catch {
      try { await chrome.contentSettings.notifications.clear({}); } catch { /* Retry on exit. */ }
      return false;
    }
  }

  async function restoreNotifications() {
    const saved = await chrome.storage.local.get('examNotificationsBlocked');
    if (saved.examNotificationsBlocked !== true) return;
    const allowed = await chrome.permissions.contains({ permissions: ['contentSettings'] });
    if (!allowed) return;
    try {
      // clear() removes only rules set by this extension.
      await chrome.contentSettings.notifications.clear({});
      await chrome.storage.local.set({ examNotificationsBlocked: false });
    } catch { /* Keep the flag so a later restore can retry. */ }
  }

  async function enterExamMode(reason) {
    await chrome.storage.local.set({ examBlockedCount: 0 });
    const hasPermission = await chrome.permissions.contains({ permissions: ['management'] });
    if (!hasPermission) {
      await blockNotifications();
      await chrome.storage.local.set({ examDisableFailures: 0 });
      return { disabledCount: (await disabledIds()).length, failed: 0 };
    }

    const existing = new Set(await disabledIds());
    const saved = await chrome.storage.local.get('examKeepIds');
    const keepIds = new Set(Array.isArray(saved.examKeepIds)
      ? saved.examKeepIds.filter(id => typeof id === 'string') : []);
    let failed = 0;
    let extensions;
    try { extensions = await chrome.management.getAll(); }
    catch {
      await blockNotifications();
      await chrome.storage.local.set({ examDisableFailures: 1 });
      return { disabledCount: existing.size, failed: 1 };
    }
    for (const item of extensions) {
      if (item.type !== 'extension' || !item.enabled || item.mayDisable === false ||
          item.id === chrome.runtime.id || existing.has(item.id) || keepIds.has(item.id)) continue;
      try {
        await chrome.management.setEnabled(item.id, false);
        existing.add(item.id);
        // Save each success so a sleeping worker or closed popup cannot lose the restore list.
        await chrome.storage.local.set({ [IDS_KEY]: [...existing] });
      } catch { failed++; }
    }
    await blockNotifications();
    await chrome.storage.local.set({ examRestorePending: false, examDisableFailures: failed });
    return { disabledCount: existing.size, failed };
  }

  async function exitExamMode() {
    await restoreNotifications();
    const ids = await disabledIds();
    if (ids.length && !await chrome.permissions.contains({ permissions: ['management'] })) {
      await chrome.storage.local.set({ examRestorePending: true });
      return { pendingRestore: ids.length };
    }
    const remaining = [];
    for (const id of ids) {
      let item;
      try { item = await chrome.management.get(id); }
      catch { continue; } // Removed extensions no longer need restoring.
      if (item.enabled) continue;
      try { await chrome.management.setEnabled(id, true); }
      catch { remaining.push(id); }
    }
    await chrome.storage.local.set({
      [IDS_KEY]: remaining,
      examRestorePending: remaining.length > 0,
      examDisableFailures: 0
    });
    return { pendingRestore: remaining.length };
  }

  return { EXAM_URL, disabledIds, enterExamMode, exitExamMode };
})();
