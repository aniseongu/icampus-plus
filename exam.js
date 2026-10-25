// Shared by the service worker and popup. Keep the URL rule in sync with dark/boot.js.
const ExamMode = (() => {
  function logExam(description, error) {
    if (typeof reportError === 'function') reportError('exam', description + ': ' +
      String(error?.message || '알 수 없는 오류'), { stack: error?.stack });
  }
  const EXAM_URL = /^https:\/\/canvas\.skku\.edu\/courses\/\d+\/quizzes\/\d+\/take(?:[/?#]|$)/;
  const IDS_KEY = 'examDisabledIds';
  const MAX_RESTORE_AGE = 7 * 24 * 60 * 60 * 1000;

  function validIds(value) {
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : [];
  }

  async function disabledState() {
    const [session, local] = await Promise.all([
      chrome.storage.session.get(IDS_KEY),
      chrome.storage.local.get([IDS_KEY, 'examStartedAt'])
    ]);
    if (Object.hasOwn(session, IDS_KEY)) {
      return { ids: validIds(session[IDS_KEY]), source: 'session', startedAt: local.examStartedAt };
    }
    return { ids: validIds(local[IDS_KEY]), source: 'local', startedAt: local.examStartedAt };
  }

  async function disabledIds() {
    return (await disabledState()).ids;
  }

  function isStale(startedAt) {
    return !Number.isFinite(startedAt) || startedAt > Date.now() ||
      Date.now() - startedAt > MAX_RESTORE_AGE;
  }

  async function markManualRestore(ids) {
    await chrome.storage.session.set({ [IDS_KEY]: [], examRestoreManualIds: ids });
    await chrome.storage.local.set({ [IDS_KEY]: [], examRestorePending: true,
      examRestoreManual: true, examRestoreManualIds: ids, examStartedAt: null });
  }

  async function blockNotifications() {
    const allowed = await chrome.permissions.contains({ permissions: ['contentSettings'] });
    if (!allowed) return false;
    try {
      await chrome.contentSettings.notifications.set({ primaryPattern: '<all_urls>', setting: 'block' });
      await chrome.storage.local.set({ examNotificationsBlocked: true });
      return true;
    } catch (error) {
      logExam('시험 알림 차단 실패', error);
      try { await chrome.contentSettings.notifications.clear({}); }
      catch (clearError) { logExam('시험 알림 차단 복구 실패', clearError); }
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
    } catch (error) { logExam('시험 알림 설정 복원 실패', error); }
  }

  async function enterExamMode(reason) {
    await chrome.storage.session.set({ examBlockedCount: 0 });
    const hasPermission = await chrome.permissions.contains({ permissions: ['management'] });
    if (!hasPermission) {
      await blockNotifications();
      await chrome.storage.local.set({ examDisableFailures: 0 });
      return { disabledCount: (await disabledIds()).length, failed: 0 };
    }

    const previous = await disabledState();
    let existing = new Set(previous.ids);
    if (previous.source === 'local') {
      if (existing.size && isStale(previous.startedAt)) {
        await markManualRestore([...existing]);
        existing = new Set();
        await chrome.storage.local.set({ examStartedAt: Date.now() });
      } else {
        const verified = [];
        for (const id of existing) {
          try {
            const item = await chrome.management.get(id);
            if (item.type === 'extension' && item.enabled === false && id !== chrome.runtime.id) verified.push(id);
          } catch (error) {
            if (!/No extension with id/i.test(String(error?.message || '')))
              logExam('시험 중 확장 상태 확인 실패', error);
          }
        }
        existing = new Set(verified);
        await chrome.storage.session.set({ [IDS_KEY]: verified });
        await chrome.storage.local.set({ [IDS_KEY]: verified,
          examStartedAt: verified.length ? previous.startedAt : Date.now() });
      }
    } else if (!existing.size) {
      await chrome.storage.local.set({ examStartedAt: Date.now() });
    }
    const saved = await chrome.storage.local.get('examKeepIds');
    const keepIds = new Set(Array.isArray(saved.examKeepIds)
      ? saved.examKeepIds.filter(id => typeof id === 'string') : []);
    let failed = 0;
    let extensions;
    try { extensions = await chrome.management.getAll(); }
    catch (error) {
      logExam('확장 목록 조회 실패', error);
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
        // Session is authoritative; local is only a restart backup.
        await chrome.storage.session.set({ [IDS_KEY]: [...existing] });
        await chrome.storage.local.set({ [IDS_KEY]: [...existing] });
      } catch (error) { failed++; logExam('시험 중 확장 끄기 실패', error); }
    }
    await blockNotifications();
    await chrome.storage.local.set({ examRestorePending: false, examDisableFailures: failed });
    return { disabledCount: existing.size, failed };
  }

  async function exitExamMode({ manualRestore = false } = {}) {
    await restoreNotifications();
    const [manual, localManual] = await Promise.all([
      chrome.storage.session.get('examRestoreManualIds'),
      chrome.storage.local.get('examRestoreManualIds')
    ]);
    const manualIds = validIds(Object.hasOwn(manual, 'examRestoreManualIds')
      ? manual.examRestoreManualIds : localManual.examRestoreManualIds);
    const state = await disabledState();
    if (state.source === 'local' && state.ids.length && isStale(state.startedAt)) {
      await markManualRestore(state.ids);
      return manualRestore ? exitExamMode({ manualRestore: true })
        : { pendingRestore: state.ids.length };
    }
    const restoringManual = manualRestore && manualIds.length > 0;
    const ids = restoringManual ? manualIds : state.ids;
    if (ids.length && !await chrome.permissions.contains({ permissions: ['management'] })) {
      await chrome.storage.local.set({ examRestorePending: true });
      return { pendingRestore: ids.length };
    }
    const remaining = [];
    for (const id of ids) {
      let item;
      try { item = await chrome.management.get(id); }
      catch (error) {
        if (!/No extension with id/i.test(String(error?.message || '')))
          logExam('시험 후 확장 상태 확인 실패', error);
        continue;
      }
      if (item.type !== 'extension' || item.id === chrome.runtime.id || item.enabled !== false) continue;
      try { await chrome.management.setEnabled(id, true); }
      catch (error) { remaining.push(id); logExam('시험 후 확장 복원 실패', error); }
    }
    const nextNormal = restoringManual ? state.ids : remaining;
    const nextManual = restoringManual ? remaining : manualIds;
    await chrome.storage.session.set({ [IDS_KEY]: nextNormal, examRestoreManualIds: nextManual });
    await chrome.storage.local.set({
      [IDS_KEY]: nextNormal,
      examRestorePending: nextNormal.length > 0 || nextManual.length > 0,
      examRestoreManual: nextManual.length > 0,
      examRestoreManualIds: nextManual,
      examStartedAt: nextNormal.length ? (state.startedAt || Date.now()) : null,
      examDisableFailures: 0
    });
    return { pendingRestore: nextNormal.length + nextManual.length };
  }

  return { EXAM_URL, disabledIds, enterExamMode, exitExamMode };
})();
