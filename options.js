// The settings page: every row the popup used to hold under 설정.
let examKeepIds = new Set();
let examKeepSaving = false;
let errorLogEnabled = false;

async function renderExamKeepList() {
  const list = document.querySelector('#exam-keep-list');
  if (!examStatus?.hasManagementPermission) return;
  list.replaceChildren(element('p', 'setting-help', '확장 목록을 불러오는 중이에요'));
  try {
    const [extensions, saved] = await Promise.all([
      chrome.management.getAll(), chrome.storage.local.get('examKeepIds')
    ]);
    examKeepIds = new Set(Array.isArray(saved.examKeepIds)
      ? saved.examKeepIds.filter(id => typeof id === 'string') : []);
    const choices = extensions.filter(item => item.type === 'extension' &&
      item.id !== chrome.runtime.id && item.mayDisable !== false);
    choices.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    if (!choices.length) {
      list.replaceChildren(element('p', 'setting-help', '다른 확장이 없어요'));
      return;
    }
    const rows = choices.map(item => {
      const row = element('label', 'exam-keep-option');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = examKeepIds.has(item.id);
      check.disabled = !examStatus.guard || examKeepSaving;
      check.addEventListener('change', async () => {
        if (!examStatus.guard) return;
        const before = new Set(examKeepIds);
        if (check.checked) examKeepIds.add(item.id);
        else examKeepIds.delete(item.id);
        examKeepSaving = true;
        for (const input of list.querySelectorAll('input')) input.disabled = true;
        try {
          await chrome.storage.local.set({ examKeepIds: [...examKeepIds] });
        } catch (error) {
          logPopup('시험 중 켤 확장 저장 실패')(error);
          examKeepIds = before;
          check.checked = before.has(item.id);
          document.querySelector('#exam-status').textContent = '선택을 저장하지 못했어요. 다시 골라 주세요';
        } finally {
          examKeepSaving = false;
          for (const input of list.querySelectorAll('input')) input.disabled = !examStatus.guard;
        }
      });
      row.append(check, document.createTextNode(item.name));
      return row;
    });
    list.replaceChildren(...rows);
  } catch (error) {
    logPopup('확장 목록 읽기 실패')(error);
    list.replaceChildren(element('p', 'setting-help', '확장 목록을 불러오지 못했어요. 다시 열어 주세요'));
  }
}

// Exam rows; the popup only shows the banner and the exam notice.
async function refreshExamSettings() {
  try {
    examStatus = await fetchExamStatus();
    const status = examStatus;
    for (const option of document.querySelectorAll('#exam-guard [data-guard]')) {
      option.setAttribute('aria-checked', String((option.dataset.guard === 'true') === status.guard));
    }
    for (const option of document.querySelectorAll('#exam-fullscreen [data-fullscreen]')) {
      option.setAttribute('aria-checked', String((option.dataset.fullscreen === 'true') === status.fullscreen));
      option.disabled = !status.guard;
    }
    // The sub-settings below 시험 모드 only show while it is on.
    document.querySelector('#exam-fullscreen-group').hidden = !status.guard;
    const keep = document.querySelector('#exam-keep');
    keep.hidden = !status.guard || !status.hasManagementPermission;
    keep.inert = !status.guard;
    keep.setAttribute('aria-disabled', String(!status.guard));
    if (!status.guard || !status.hasManagementPermission) keep.open = false;
    for (const input of keep.querySelectorAll('input')) input.disabled = !status.guard || examKeepSaving;
    const label = document.querySelector('#exam-status');
    const action = document.querySelector('#exam-action');
    const active = status.manual || status.examTabs > 0;
    document.querySelector('#exam-controls').hidden = !status.guard;
    action.hidden = false;
    if (!status.hasPermission) {
      label.textContent = !status.hasManagementPermission && !status.hasContentSettingsPermission
        ? '다른 확장과 사이트 알림을 막으려면 권한이 필요해요'
        : !status.hasManagementPermission
          ? '다른 확장을 끄려면 권한이 필요해요'
          : '사이트 알림을 막으려면 권한이 필요해요';
      action.textContent = '허용하기';
    } else {
      label.textContent = (active
        ? status.disableFailures > 0
          ? `시험 중이에요. 확장 ${status.disableFailures}개를 끄지 못했어요`
          : status.disabledCount > 0
            ? `시험 중이에요. 확장 ${status.disabledCount}개를 꺼 두었어요`
            : '시험 중이에요'
        : '퀴즈 화면을 열면 시작해요') + (active ? examBlockedText() : '');
      action.textContent = status.manual ? '끝내기' : '지금 시작';
      if (!status.manual && status.disableFailures > 0) action.textContent = '다시 시도';
      action.hidden = status.manual || (active && status.disableFailures === 0);
    }
  } catch (error) {
    logPopup('시험 상태 확인 실패')(error);
    document.querySelector('#exam-status').textContent = '상태를 확인하지 못했어요. 다시 열어 주세요';
  }
}

async function handleExamAction() {
  const button = document.querySelector('#exam-action');
  if (button.disabled || !examStatus) return;
  button.disabled = true;
  try {
    if (!examStatus.hasPermission) {
      await chrome.permissions.request({ permissions: ['management', 'contentSettings'] });
      if (examStatus.examTabs || examStatus.manual) await ExamMode.enterExamMode('manual');
      else if (examStatus.pendingRestore || examStatus.restoreNeedsApproval ||
          examStatus.notificationsBlocked || examStatus.notificationRestorePending) {
        await ExamMode.exitExamMode({ manualRestore: true });
      }
    } else if (examStatus.manual) {
      await chrome.storage.local.set({ examModeManual: false });
      if (!examStatus.examTabs) await ExamMode.exitExamMode();
    } else if (examStatus.examTabs && examStatus.disableFailures > 0) {
      await ExamMode.enterExamMode('manual');
    } else {
      await chrome.storage.local.set({ examModeManual: true });
      await ExamMode.enterExamMode('manual');
    }
  } catch (error) {
    logPopup('시험 모드 전환 실패')(error);
    document.querySelector('#exam-status').textContent = '확장 상태를 바꾸지 못했어요. 다시 눌러 주세요';
  } finally {
    button.disabled = false;
    await refreshExamSettings();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  observeLightInk();
  await loadScreenMode();
  colorMedia.addEventListener('change', applyTheme);
  applyTheme();
  for (const option of document.querySelectorAll('#screen-mode [data-mode]')) {
    option.addEventListener('click', () => setScreenMode(option.dataset.mode));
  }
  for (const option of document.querySelectorAll('#night-guard [data-night-guard]')) {
    option.addEventListener('click', () => setNightGuard(option.dataset.nightGuard === 'true'));
  }
  const errorLogOptions = [...document.querySelectorAll('#error-log [data-error-log]')];
  const errorLogStatus = document.querySelector('#error-log-status');
  const errorLogHelp = errorLogStatus.textContent;
  async function refreshErrorLogPermission() {
    errorLogEnabled = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
    for (const option of errorLogOptions) {
      option.setAttribute('aria-checked', String((option.dataset.errorLog === 'true') === errorLogEnabled));
    }
  }
  for (const option of errorLogOptions) {
    option.addEventListener('click', async () => {
      const enable = option.dataset.errorLog === 'true';
      if (option.disabled || enable === errorLogEnabled) return;
      errorLogOptions.forEach(control => { control.disabled = true; });
      try {
        if (enable) await chrome.permissions.request({ permissions: ['nativeMessaging'] });
        else await chrome.permissions.remove({ permissions: ['nativeMessaging'] });
        errorLogStatus.textContent = errorLogHelp;
        await refreshErrorLogPermission();
      } catch (error) {
        logPopup('오류 기록 권한 변경 실패')(error);
        errorLogStatus.textContent = '설정을 바꾸지 못했어요. 다시 눌러 주세요';
      } finally {
        errorLogOptions.forEach(control => { control.disabled = false; });
      }
    });
  }
  chrome.permissions.onAdded.addListener(refreshErrorLogPermission);
  chrome.permissions.onRemoved.addListener(refreshErrorLogPermission);
  // Do not let the optional error-log row block the rest of the popup.
  refreshErrorLogPermission().catch(logPopup('오류 기록 권한 확인 실패'));
  document.querySelector('#exam-keep').addEventListener('toggle', event => {
    const keep = event.currentTarget;
    keep.querySelector('summary .playlist-action').textContent = keep.open ? '접기' : '펼치기';
    if (keep.open) renderExamKeepList().catch(logPopup('시험 중 켤 확장 목록 실패'));
  });
  // Shortcut: manifest commands._execute_action (suggested Alt+Shift+K). Users
  // change it on the browser's extension shortcuts page.
  const shortcutStatus = document.querySelector('#shortcut-status');
  chrome.commands.getAll().then(commands => {
    const key = commands.find(command => command.name === '_execute_action')?.shortcut;
    shortcutStatus.textContent = key ? key.replace(/\+/g, ' + ') + ' 키로 열어요'
      : '단축키가 없어요. 바꾸기에서 정할 수 있어요';
  }).catch(logPopup('단축키 조회 실패'));
  document.querySelector('#shortcut-change').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(logPopup('단축키 화면 열기 실패'));
  });
  // 영상 저장: the optional permissions are the switch (D-019, same set as background.js).
  const videoPermissions = { permissions: ['downloads'], origins: ['https://vod.skku.edu/*'] };
  const videoOptions = [...document.querySelectorAll('#video-save [data-video-save]')];
  const videoStatus = document.querySelector('#video-save-status');
  const videoHelp = videoStatus.textContent;
  async function refreshVideoSave() {
    const enabled = await chrome.permissions.contains(videoPermissions);
    videoOptions.forEach(option =>
      option.setAttribute('aria-checked', String((option.dataset.videoSave === 'true') === enabled)));
    return enabled;
  }
  refreshVideoSave().catch(logPopup('영상 저장 상태 확인 실패'));
  for (const option of videoOptions) {
    option.addEventListener('click', async () => {
      const enable = option.dataset.videoSave === 'true';
      videoOptions.forEach(control => { control.disabled = true; });
      try {
        if (enable) await chrome.permissions.request(videoPermissions);
        else await chrome.permissions.remove(videoPermissions);
        const on = await refreshVideoSave();
        videoStatus.textContent = on ? '켜졌어요. 강의 화면을 새로고침하면 버튼이 보여요' : videoHelp;
      } catch (error) {
        logPopup('영상 저장 권한 변경 실패')(error);
        videoStatus.textContent = '설정을 바꾸지 못했어요. 다시 눌러 주세요';
      } finally {
        videoOptions.forEach(control => { control.disabled = false; });
      }
    });
  }
  // Alerts: on by default. The worker reacts to the stored value (notify.js).
  const notifyOptions = [...document.querySelectorAll('#notify [data-notify]')];
  // New announcements and released grades follow the main switch: the row
  // hides while alerts are off, like the exam rows under exam mode.
  const activityRow = document.querySelector('#activity-notify-row');
  const activityOptions = [...document.querySelectorAll('#activity-notify [data-activity-notify]')];
  const leadRow = document.querySelector('#lead-row');
  const leadOpen = document.querySelector('#lead-open');
  const leadEditor = document.querySelector('#lead-editor');
  const leadStatus = document.querySelector('#lead-status');
  const leadOptions = [...document.querySelectorAll('#lead-choices [data-lead]')];
  const summaryRow = document.querySelector('#summary-row');
  const summaryTime = document.querySelector('#summary-time');
  const summaryStatus = document.querySelector('#summary-status');
  const summaryOptions = [...document.querySelectorAll('#summary [data-summary]')];
  const setLeadEditor = open => {
    leadEditor.hidden = !open;
    leadOpen.setAttribute('aria-expanded', String(open));
    leadOpen.textContent = open ? '닫기' : '바꾸기';
  };
  const showNotify = enabled => {
    notifyOptions.forEach(option =>
      option.setAttribute('aria-checked', String((option.dataset.notify === 'true') === enabled)));
    for (const row of [leadRow, summaryRow, activityRow]) row.hidden = !enabled;
    if (!enabled) setLeadEditor(false);
  };
  // Deadline alert moments: any of the six, saved on each tap (notify.js reads
  // alertLeadMinutes). Nothing chosen means no deadline alerts.
  const leadName = minutes => minutes >= 1440 ? (minutes === 1440 ? '하루' : minutes / 1440 + '일')
    : minutes >= 60 ? minutes / 60 + '시간' : minutes + '분';
  const showLeads = leads => {
    leadOptions.forEach(option => option.setAttribute('aria-checked', String(leads.includes(Number(option.dataset.lead)))));
    leadStatus.textContent = leads.length
      ? '마감 ' + leads.map(lead => leadName(lead) + ' 전').join(', ') + '에 알려요'
      : '마감 알림을 보내지 않아요';
  };
  const savedLeads = value => Array.isArray(value) && value.every(Number.isInteger)
    ? [...new Set(value)].sort((a, b) => b - a) : [1440, 180];
  // Daily summary: the time stays in the field while it is off, so turning it
  // on uses the time shown (dailySummaryClock); dailySummaryTime is set only while on.
  const clockText = value => {
    const [hour, minute] = value.split(':').map(Number);
    return (hour < 12 ? '오전 ' : '오후 ') + (hour % 12 || 12) + '시' + (minute ? ' ' + minute + '분' : '');
  };
  const showSummary = (on, clock) => {
    summaryTime.value = clock;
    summaryOptions.forEach(option =>
      option.setAttribute('aria-checked', String((option.dataset.summary === 'true') === on)));
    // From 18:00 the summary covers tomorrow too (notify.js), and says so.
    const range = Number(clock.split(':')[0]) >= 18 ? '내일까지' : '오늘';
    summaryStatus.textContent = on ? '매일 ' + clockText(clock) + '에 ' + range + ' 마감을 알려요'
      : '하루 한 번 오늘 마감을 모아서 알려요';
  };
  const validClock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value : '09:00';
  chrome.storage.local.get(['alertLeadMinutes', 'dailySummaryTime', 'dailySummaryClock']).then(saved => {
    showLeads(savedLeads(saved.alertLeadMinutes));
    showSummary(Boolean(saved.dailySummaryTime), validClock(saved.dailySummaryTime || saved.dailySummaryClock));
  }).catch(logPopup('알림 시점 설정 읽기 실패'));
  leadOpen.addEventListener('click', () => setLeadEditor(leadEditor.hidden));
  for (const option of leadOptions) {
    option.addEventListener('click', async () => {
      option.setAttribute('aria-checked', String(option.getAttribute('aria-checked') !== 'true'));
      const leads = leadOptions.filter(item => item.getAttribute('aria-checked') === 'true')
        .map(item => Number(item.dataset.lead));
      showLeads(leads);
      await chrome.storage.local.set({ alertLeadMinutes: leads });
    });
  }
  const saveSummary = async on => {
    const clock = validClock(summaryTime.value);
    showSummary(on, clock);
    await chrome.storage.local.set({ dailySummaryClock: clock, dailySummaryTime: on ? clock : null });
  };
  for (const option of summaryOptions) {
    option.addEventListener('click', () => saveSummary(option.dataset.summary === 'true'));
  }
  summaryTime.addEventListener('change', () => {
    if (!summaryTime.value) return;
    saveSummary(summaryOptions.some(option => option.dataset.summary === 'true' &&
      option.getAttribute('aria-checked') === 'true'));
  });
  const showActivityNotify = enabled => activityOptions.forEach(option =>
    option.setAttribute('aria-checked', String((option.dataset.activityNotify === 'true') === enabled)));
  chrome.storage.local.get('notifyEnabled').then(saved => showNotify(saved.notifyEnabled !== false)).catch(logPopup('알림 설정 읽기 실패'));
  chrome.storage.local.get('activityNotifyEnabled').then(saved =>
    showActivityNotify(saved.activityNotifyEnabled !== false)).catch(logPopup('공지 알림 설정 읽기 실패'));
  for (const option of notifyOptions) {
    option.addEventListener('click', async () => {
      const enabled = option.dataset.notify === 'true';
      showNotify(enabled);
      await chrome.storage.local.set({ notifyEnabled: enabled });
      refreshCanvasToken();
    });
  }
  for (const option of activityOptions) {
    option.addEventListener('click', async () => {
      const enabled = option.dataset.activityNotify === 'true';
      showActivityNotify(enabled);
      await chrome.storage.local.set({ activityNotifyEnabled: enabled });
    });
  }
  // Canvas personal token: the worker keeps it (secrets.js) and only ever sends
  // back a status. The field opens on demand and is cleared as soon as it is sent.
  const tokenOpen = document.querySelector('#canvas-token-open');
  const tokenClear = document.querySelector('#canvas-token-clear');
  const tokenStatus = document.querySelector('#canvas-token-status');
  const tokenEditor = document.querySelector('#canvas-token-editor');
  const tokenInput = document.querySelector('#canvas-token-input');
  const tokenSave = document.querySelector('#canvas-token-save');
  const tokenClose = document.querySelector('#canvas-token-close');
  const tokenHelp = document.querySelector('#canvas-token-help');
  const tokenHelpText = tokenHelp.textContent.replace(/\s+/g, ' ').trim();
  const tokenErrors = {
    empty: '토큰을 붙여 넣어 주세요',
    'invalid-format': '토큰만 복사해서 붙여 넣어 주세요',
    rejected: '맞지 않는 토큰이에요. 다시 복사해서 넣어 주세요',
    'other-account': '알림을 받는 계정에서 만든 토큰을 넣어 주세요',
    network: '아이캠퍼스에 연결하지 못했어요. 잠시 뒤 다시 눌러 주세요',
    slow: '확인이 늦어지고 있어요. 잠시 뒤 팝업을 다시 열어 주세요'
  };
  let tokenBusy = false;
  // The worker answers token messages without waiting for the scan, but a busy or
  // just-woken worker can still be slow; the popup never waits on it forever.
  const tokenMessage = (message, ms) => Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), ms))
  ]);
  // Canvas names carry a masked student number in brackets; the name is enough here.
  const accountName = name => String(name || '').replace(/\s*\([^)]*\)\s*$/, '') || '내';
  function setTokenEditor(open) {
    tokenEditor.hidden = !open;
    tokenOpen.setAttribute('aria-expanded', String(open));
    if (open) {
      tokenHelp.textContent = tokenHelpText;
      tokenInput.focus();
    } else {
      tokenInput.value = '';
    }
  }
  // Lecture schedule while signed out needs the optional cookies permission:
  // the worker reads the LearningX cookie instead of a tab (notify.js).
  const lectureRow = document.querySelector('#lecture-access-row');
  const lectureStatus = document.querySelector('#lecture-access-status');
  const lectureOptions = [...document.querySelectorAll('#lecture-access [data-lecture-access]')];
  const cookiePermission = { permissions: ['cookies'] };
  const showLectureAccess = (on, message) => {
    lectureOptions.forEach(option =>
      option.setAttribute('aria-checked', String((option.dataset.lectureAccess === 'true') === on)));
    lectureStatus.textContent = message || (on ? '로그아웃해도 강의 마감을 같이 확인하고 있어요'
      : '로그아웃해도 강의 마감까지 확인해요');
  };
  chrome.permissions.contains(cookiePermission).then(on => showLectureAccess(on)).catch(logPopup('쿠키 권한 확인 실패'));
  for (const option of lectureOptions) {
    option.addEventListener('click', async () => {
      const on = option.dataset.lectureAccess === 'true';
      try {
        const granted = on ? await chrome.permissions.request(cookiePermission)
          : !(await chrome.permissions.remove(cookiePermission));
        showLectureAccess(granted, on && !granted ? '권한을 허용해야 강의 일정도 확인할 수 있어요' : '');
      } catch (error) {
        logPopup('쿠키 권한 변경 실패')(error);
        showLectureAccess(await chrome.permissions.contains(cookiePermission).catch(error => { logPopup('쿠키 권한 확인 실패')(error); return false; }),
          '설정을 바꾸지 못했어요. 다시 눌러 주세요');
      }
    });
  }
  function showCanvasToken(status, scan, notifyOn) {
    const usable = Boolean(status?.set && !status.rejectedAt);
    tokenOpen.hidden = usable;
    tokenOpen.textContent = status?.rejectedAt ? '다시 넣기' : '토큰 넣기';
    tokenClear.hidden = !status?.set;
    lectureRow.hidden = !usable;
    if (usable) setTokenEditor(false);
    const name = accountName(status?.name);
    if (status?.rejectedAt) {
      tokenStatus.textContent = '토큰이 맞지 않아요. 새 토큰을 넣어 주세요';
    } else if (usable && !notifyOn) {
      tokenStatus.textContent = '알림을 켜면 ' + name + ' 계정으로 확인해요';
    } else if (usable) {
      tokenStatus.textContent = name + ' 계정으로 확인하고 있어요';
    } else if (scan?.problem === 'signed-out') {
      tokenStatus.textContent = '토큰을 넣으면 지금처럼 로그인이 풀려도 과제를 확인해요';
    } else {
      tokenStatus.textContent = '로그인이 풀려도 과제와 퀴즈를 확인해요';
    }
  }
  async function refreshCanvasToken() {
    try {
      const [status, saved] = await Promise.all([
        tokenMessage({ type: 'icampus-canvas-token-status' }, 5000),
        chrome.storage.local.get(['icampusScanState', 'notifyEnabled'])
      ]);
      if (tokenBusy) return;
      if (status?.error) throw new Error(status.error);
      showCanvasToken(status, saved.icampusScanState, saved.notifyEnabled !== false);
    } catch (error) {
      logPopup('토큰 상태 확인 실패')(error);
      if (!tokenBusy) tokenStatus.textContent = tokenErrors.network;
    }
  }
  function setTokenBusy(busy) {
    tokenBusy = busy;
    for (const control of [tokenOpen, tokenClear, tokenInput, tokenSave, tokenClose]) control.disabled = busy;
  }
  async function saveCanvasToken() {
    if (tokenBusy) return;
    const token = tokenInput.value.trim();
    tokenInput.value = '';
    if (!token) {
      tokenHelp.textContent = tokenErrors.empty;
      tokenInput.focus();
      return;
    }
    setTokenBusy(true);
    tokenHelp.textContent = '토큰을 확인하고 있어요';
    let error = null;
    try {
      error = (await tokenMessage({ type: 'icampus-canvas-token-set', token }, 15000))?.error || null;
    } catch (failure) {
      error = failure?.message === 'slow' ? 'slow' : 'network';
    } finally {
      setTokenBusy(false);
    }
    // A slow save may still have landed; the status read below closes the field if so.
    if (error) {
      tokenHelp.textContent = tokenErrors[error] || tokenErrors.network;
      if (error !== 'slow') tokenInput.focus();
    }
    await refreshCanvasToken();
  }
  async function clearCanvasToken() {
    if (tokenBusy) return;
    setTokenBusy(true);
    try { await tokenMessage({ type: 'icampus-canvas-token-clear' }, 15000); }
    catch (error) { logPopup('Canvas 토큰 지우기 실패')(error); /* The status refresh below shows what is stored. */ }
    finally { setTokenBusy(false); }
    setTokenEditor(false);
    await refreshCanvasToken();
  }
  tokenOpen.addEventListener('click', () => setTokenEditor(tokenEditor.hidden));
  tokenClose.addEventListener('click', () => { setTokenEditor(false); tokenOpen.focus(); });
  tokenSave.addEventListener('click', saveCanvasToken);
  tokenClear.addEventListener('click', clearCanvasToken);
  tokenInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); saveCanvasToken(); }
    else if (event.key === 'Escape') { event.preventDefault(); setTokenEditor(false); tokenOpen.focus(); }
  });
  refreshCanvasToken();
  // Google Calendar: the worker signs in and syncs (gcal.js); the popup only
  // hands over the user's own OAuth client and asks for the optional permissions.
  const gcalOpen = document.querySelector('#gcal-open');
  const gcalKeep = document.querySelector('#gcal-keep');
  const gcalDisconnect = document.querySelector('#gcal-disconnect');
  const gcalStatus = document.querySelector('#gcal-status');
  const gcalEditor = document.querySelector('#gcal-editor');
  const gcalClient = document.querySelector('#gcal-client');
  const gcalSecret = document.querySelector('#gcal-secret');
  const gcalConnect = document.querySelector('#gcal-connect');
  const gcalClose = document.querySelector('#gcal-close');
  const gcalHelp = document.querySelector('#gcal-help');
  const gcalPermission = { permissions: ['identity'],
    origins: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'] };
  const gcalErrors = {
    cancelled: '연결을 취소했어요', client: '클라이언트 ID를 다시 확인해 주세요',
    secret: '보안 비밀번호를 다시 확인해 주세요',
    permission: '권한을 허용해야 연결할 수 있어요', network: '연결하지 못했어요. 다시 눌러 주세요'
  };
  // Why the worker gave up; each names what the user can do about it.
  const gcalLost = {
    'google-login': '구글 로그인이 풀려서 끊겼어요. 다시 연결해 주세요',
    'account-choice': '구글 계정을 고를 수 없어 끊겼어요. 다시 연결해 주세요',
    consent: '구글 권한 동의가 필요해요. 다시 연결해 주세요',
    'token-revoked': '구글에서 연결이 해제됐어요. 다시 연결해 주세요',
    'client-secret': '보안 비밀번호가 맞지 않아요. 비밀번호 넣기에서 다시 넣어 주세요',
    'testing-expired': '구글 클라우드 앱이 테스트 상태라 7일마다 끊겨요. 게시 상태를 프로덕션으로 바꿔 주세요'
  };
  const gcalHelpText = '보안 비밀번호까지 넣으면 구글 로그인이 풀려도 연결이 이어져요. 만드는 방법은 README에 있어요';
  let gcalHasClient = false;
  let gcalPermitted = false;
  let gcalWaiting = false;
  function setGcalEditor(open, from = gcalOpen) {
    gcalEditor.hidden = !open;
    for (const control of [gcalOpen, gcalKeep]) control.setAttribute('aria-expanded', String(open && control === from));
    if (open) {
      gcalHelp.textContent = gcalHelpText;
      (gcalHasClient ? gcalSecret : gcalClient).focus();
    }
  }
  function gcalTime(ms) {
    const at = new Date(ms);
    const day = at.toDateString() === new Date().toDateString() ? '' : (at.getMonth() + 1) + '월 ' + at.getDate() + '일 ';
    return day + at.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  }
  function showGcal(status) {
    gcalHasClient = Boolean(status?.hasClientId);
    gcalClient.placeholder = gcalHasClient ? '저장된 클라이언트 ID 그대로 쓰기' : '클라이언트 ID 붙여 넣기';
    const connected = Boolean(status?.enabled);
    const lost = connected && status.problem === 'reconnect';
    // An old connection without the calendar-list grant reconnects to merge duplicates.
    const relink = lost || connected && Boolean(status.needsListConsent);
    gcalOpen.hidden = connected && !relink;
    gcalOpen.textContent = relink ? '다시 연결' : '연결하기';
    gcalKeep.hidden = !connected || (relink && status.reason !== 'client-secret') || Boolean(status.offline) && status.reason !== 'client-secret';
    gcalDisconnect.hidden = !connected;
    if (gcalWaiting) return;
    gcalStatus.textContent = status?.connectError ? gcalErrors[status.connectError] || gcalErrors.network
      : lost ? gcalLost[status.reason] || '연결이 끊겼어요. 다시 연결해 주세요'
        : connected && status.problem === 'network' ? '지금은 구글에 닿지 않아요. 1시간 안에 다시 맞출게요'
          : connected && status.needsListConsent ? '다시 연결하면 아캠 플러스 캘린더를 하나로 합쳐요'
          : connected && status.lastSyncAt ? gcalTime(status.lastSyncAt) + '에 일정 ' + (status.count || 0) + '개를 맞췄어요'
            // Merging happens once; a later sync keeps the note but under its own time.
            + (!status.merged ? '' : status.mergedAt === status.lastSyncAt ? '. 겹친 캘린더 ' + status.merged + '개도 정리했어요'
              : '. ' + gcalTime(status.mergedAt) + '에 겹친 캘린더 ' + status.merged + '개를 정리했어요')
            : connected ? '아캠 플러스 캘린더에 일정을 넣는 중이에요'
              : '즐겨찾기 과목 일정을 구글 캘린더에 넣어요';
  }
  async function refreshGcal() {
    try { showGcal(await tokenMessage({ type: 'icampus-gcal-status' }, 5000)); }
    catch (error) { logPopup('구글 캘린더 상태 확인 실패')(error); /* Keeps the default text. */ }
  }
  function gcalDone(text) {
    gcalWaiting = false;
    for (const control of [gcalOpen, gcalKeep, gcalConnect]) control.disabled = false;
    if (text) gcalStatus.textContent = gcalHelp.textContent = text;
  }
  // Called straight from the click: permissions.request needs the user gesture,
  // so nothing is awaited before it. The prompt can close the popup; the worker
  // then sees the new permission and opens the Google sign-in by itself.
  function connectGcal(clientId, clientSecret) {
    const prepared = tokenMessage({ type: 'icampus-gcal-prepare',
      ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) }, 10000)
      .catch(error => { logPopup('구글 캘린더 준비 요청 실패')(error); return { error: 'network' }; });
    const permitted = gcalPermitted;
    const granted = permitted ? Promise.resolve(true) : chrome.permissions.request(gcalPermission)
      .catch(error => { logPopup('구글 캘린더 권한 요청 실패')(error); return false; });
    gcalWaiting = true;
    for (const control of [gcalOpen, gcalKeep, gcalConnect]) control.disabled = true;
    gcalStatus.textContent = '구글 로그인 창에서 계속해 주세요';
    (async () => {
      const ready = await prepared;
      if (!(await granted)) return gcalDone(gcalErrors.permission);
      if (ready?.error) return gcalDone(gcalErrors[ready.error] || gcalErrors.network);
      gcalPermitted = true;
      // A new grant: the worker already started; storage changes refresh the status.
      if (!permitted) {
        setTimeout(() => { if (gcalWaiting) { gcalDone(); refreshGcal(); } }, 180000);
        return;
      }
      try {
        const result = await tokenMessage({ type: 'icampus-gcal-connect' }, 180000);
        if (result?.error) return gcalDone(gcalErrors[result.error] || gcalErrors.network);
        gcalDone();
        setGcalEditor(false);
        await refreshGcal();
      } catch (error) { logPopup('구글 캘린더 연결 요청 실패')(error); gcalDone(gcalErrors.network); }
    })();
  }
  gcalOpen.addEventListener('click', () => {
    if (gcalHasClient) connectGcal(null, null);
    else setGcalEditor(gcalEditor.hidden, gcalOpen);
  });
  gcalKeep.addEventListener('click', () => setGcalEditor(gcalEditor.hidden, gcalKeep));
  gcalConnect.addEventListener('click', () => {
    const clientId = gcalClient.value.trim();
    const clientSecret = gcalSecret.value.trim();
    if (clientId && !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientId && !gcalHasClient) {
      gcalHelp.textContent = '숫자로 시작하고 .apps.googleusercontent.com으로 끝나는 ID예요';
      gcalClient.focus();
      return;
    }
    if (clientSecret && !/^[\x21-\x7e]{10,200}$/.test(clientSecret)) {
      gcalHelp.textContent = gcalErrors.secret;
      gcalSecret.focus();
      return;
    }
    gcalSecret.value = '';
    connectGcal(clientId || null, clientSecret || null);
  });
  gcalClose.addEventListener('click', () => {
    const from = gcalKeep.getAttribute('aria-expanded') === 'true' ? gcalKeep : gcalOpen;
    setGcalEditor(false);
    from.focus();
  });
  for (const input of [gcalClient, gcalSecret]) {
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); gcalConnect.click(); }
      else if (event.key === 'Escape') { event.preventDefault(); gcalClose.click(); }
    });
  }
  gcalDisconnect.addEventListener('click', async () => {
    gcalDisconnect.disabled = true;
    try { await tokenMessage({ type: 'icampus-gcal-disconnect' }, 10000); }
    catch (error) { logPopup('구글 캘린더 연결 끊기 실패')(error); /* Refresh shows the state. */ }
    gcalDisconnect.disabled = false;
    await refreshGcal();
  });
  // The worker finishes a sign-in begun before a permission prompt, and syncs hourly.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes.gcalEnabled || changes.gcalState)) return;
    if (gcalWaiting && (changes.gcalEnabled?.newValue === true || changes.gcalState?.newValue?.connectError)) {
      gcalDone();
      if (changes.gcalEnabled?.newValue === true) setGcalEditor(false);
    }
    refreshGcal();
  });
  chrome.permissions.contains(gcalPermission).then(value => { gcalPermitted = value; }, logPopup('구글 캘린더 권한 확인 실패'));
  refreshGcal();
  for (const option of document.querySelectorAll('#exam-fullscreen [data-fullscreen]')) {
    option.addEventListener('click', async () => {
      await chrome.storage.local.set({ examFullscreen: option.dataset.fullscreen === 'true' });
      await refreshExamSettings();
    });
  }
  for (const option of document.querySelectorAll('#exam-guard [data-guard]')) {
    option.addEventListener('click', async () => {
      const guard = option.dataset.guard === 'true';
      await chrome.storage.local.set({ examGuard: guard });
      if (!guard) {
        await chrome.storage.local.set({ examModeManual: false });
        await ExamMode.exitExamMode();
      } else if (examStatus?.examTabs) {
        await ExamMode.enterExamMode('manual');
      }
      await refreshExamSettings();
    });
  }
  document.querySelector('#exam-action').addEventListener('click', handleExamAction);
  await refreshExamSettings();
  // The popup, the worker and Canvas tabs change these too; keep the rows current.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.screenMode && ['auto', 'light', 'dark'].includes(changes.screenMode.newValue)) {
      screenMode = changes.screenMode.newValue;
      applyTheme();
    }
    if (area === 'local' && changes.nightGuard) {
      nightGuard = changes.nightGuard.newValue !== false;
      cacheNightGuard();
      applyTheme();
    }
    if ((area === 'session' && (changes.examTabs || changes.examBlockedCount ||
        changes.examDisabledIds || changes.examRestoreManualIds)) ||
        (area === 'local' && (changes.examGuard || changes.examModeManual || changes.examFullscreen ||
        changes.examDisabledIds || changes.examRestorePending || changes.examRestoreManual ||
        changes.examNotificationsBlocked))) {
      refreshExamSettings().catch(logPopup('시험 상태 표시 실패'));
    }
  });
});
