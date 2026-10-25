// 전역 메뉴 '시간표' 보정.
// 학교 메뉴(navigateTimeTable)는 쿠키 skku_user_no가 있어야 열리는데 지금 로그인 흐름에서는 이 쿠키가 생기지 않아
// 항상 "요청을 처리할 수 없습니다"가 나온다. 쿠키가 없을 때만 정보광장 주간테이블 자동 조회 탭을 연다.
// 저장이나 학번 사용은 없다. 쿠키가 있으면 아무것도 하지 않아 학교 원래 동작을 그대로 둔다.
(() => {
  const log = error => {
    try {
      chrome.runtime.sendMessage({ type: 'icampus-error-log', source: 'timetable',
        message: '시간표 설정 읽기 실패: ' + String(error?.message || '알 수 없는 오류'),
        stack: error?.stack }).catch(() => {});
    } catch { /* Error recorder failures cannot be logged recursively. */ }
  };
  const EXAM_URL = /^https:\/\/canvas\.skku\.edu\/courses\/\d+\/quizzes\/\d+\/take(?:[/?#]|$)/;
  if (EXAM_URL.test(location.href)) return;
  const TARGET = 'https://kingoinfo.skku.edu/gaia/nxui/index.html?icd_timetable=1';
  const hasUserNo = () => /(?:^|;\s*)skku_user_no=[^;]+/.test(document.cookie);
  let examGuard = true;
  let examModeManual = false;
  let listening = false;
  const onClick = (e) => {
    if (examGuard && (examModeManual || EXAM_URL.test(location.href))) return;
    const t = e.target;
    if (!(t instanceof Element) || !t.closest('[onclick*="navigateTimeTable"]')) return;
    if (hasUserNo()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.open(TARGET, '_blank', 'noopener');
  };
  const update = () => {
    const active = examGuard && (examModeManual || EXAM_URL.test(location.href));
    if (active && listening) document.removeEventListener('click', onClick, true);
    if (!active && !listening) document.addEventListener('click', onClick, true);
    listening = !active;
  };
  chrome.storage.local.get(['examGuard', 'examModeManual']).then(saved => {
    examGuard = saved.examGuard !== false;
    examModeManual = saved.examModeManual === true;
    update();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.examGuard) examGuard = changes.examGuard.newValue !== false;
      if (changes.examModeManual) examModeManual = changes.examModeManual.newValue === true;
      if (changes.examGuard || changes.examModeManual) update();
    });
  }).catch(log);
})();
