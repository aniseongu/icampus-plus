// 아이캠퍼스 시간표 버튼이 연 정보광장 탭에서만 주간테이블을 조회한다.
// Nexacro는 URL을 바꾸지 않고 화면을 교체하므로 화면별 버튼이 준비될 때까지 짧게 기다린다.
// 로그인 정보·학번은 읽거나 저장하지 않는다. 조회 이외의 버튼은 누르지 않는다.
(async () => {
  if (new URLSearchParams(location.search).get('icd_timetable') !== '1') return;
  const log = (description, error) => {
    try {
      chrome.runtime.sendMessage({ type: 'icampus-error-log', source: 'timetable',
        message: description + ': ' + String(error?.message || '알 수 없는 오류'),
        stack: error?.stack }).catch(() => {});
    } catch { /* Logging failures cannot be logged recursively. */ }
  };
  let examBlocked = true;
  const checkExam = async () => {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'exam-status' });
      if (typeof status?.guard !== 'boolean') throw new Error('시험 상태를 확인하지 못함');
      examBlocked = status.guard && (status.manual || status.examTabs > 0);
    } catch (error) { examBlocked = true; log('시간표 시험 상태 확인 실패', error); }
  };
  await checkExam();
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'icampus-exam-blocked') {
      const wasBlocked = examBlocked;
      examBlocked = message.blocked === true;
      if (wasBlocked && !examBlocked) advance();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.examGuard || changes.examModeManual)) {
      checkExam().then(() => { if (!examBlocked) advance(); })
        .catch(error => log('시간표 조회 실패', error));
    }
  });

  const bySuffix = (suffix) => document.querySelector(`[id$="${suffix}"]`);
  const click = (el) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    // Nexacro의 Button/ListBox는 element.click()만으로는 작동하지 않는다.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0,
        buttons: type.endsWith('down') ? 1 : 0, clientX: x, clientY: y,
      }));
    }
    return true;
  };

  const currentWeek = () => {
    const term = bySuffix('.cboYearTerm')?.querySelector('input')?.value || '';
    const match = /^(\d{4})학년도\s*([12])\s*학기/.exec(term);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) === 1 ? 2 : 8; // 3월 또는 9월 첫 주
    const first = new Date(year, month, 1);
    const monday = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
    const now = new Date();
    const week = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate())) / 604800000) + 1;
    return week >= 1 && week <= 16 ? week : null;
  };

  let stage = 'home';
  let week = null;
  const deadline = Date.now() + 30000;
  const advance = () => {
    try {
      if (examBlocked) return;
      if (Date.now() > deadline || stage === 'done') return;
      if (stage === 'home') {
        if (clickIfReady('.btnLinkHS0453')) stage = 'semester';
      } else if (stage === 'semester') {
        const search = bySuffix('.divSearch.form.btnSearch');
        if (search && bySuffix('.cboYearTerm')?.querySelector('input')?.value) {
          week = currentWeek();
          if (click(search)) stage = 'week';
        }
      } else if (stage === 'week') {
        if (bySuffix('.cboWeek')) {
          if (week === null) stage = 'done'; // 선택한 학기가 현재 학기가 아니면 사용자가 강의주를 고른다.
          else if (clickIfReady('.cboWeek.dropbutton')) stage = 'week-item';
        }
      } else if (stage === 'week-item') {
        if (clickIfReady(`.cboWeek.combolist.item_${week}`)) stage = 'week-search';
      } else if (stage === 'week-search') {
        const search = document.querySelector('[id*=".popupFrame"][id$=".btnSearch"]');
        if (search && bySuffix('.cboWeek')?.querySelector('input')?.value === String(week) && click(search)) stage = 'done';
      }
      if (stage !== 'done') setTimeout(advance, 250);
    } catch (error) {
      log('시간표 자동 조회 실패', error);
    }
  };
  const clickIfReady = (suffix) => {
    const el = bySuffix(suffix);
    return !!el && click(el);
  };
  advance();
})();
