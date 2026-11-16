// inbox-merge.js(MAIN world)에 보낸 대화를 받은 편지함에 넣어도 되는지 알린다. 시험 중에는 끈다.
// 페이지 시작 때 떠서 Canvas가 첫 목록을 부르기 전에 답한다. inbox-split.js는 늦게 떠서 따로 둔다.
(() => {
  if (window.top !== window) return;
  let on = null;
  const announce = () => {
    if (on !== null) document.dispatchEvent(new Event(on ? 'icd-inbox-merge-on' : 'icd-inbox-merge-off'));
  };
  const read = () => chrome.storage.local.get(['examGuard', 'examModeManual'])
    .then(saved => { on = !(saved.examGuard === true && saved.examModeManual === true); })
    .catch(() => { on = false; })
    .then(announce);
  document.addEventListener('icd-inbox-merge-ask', announce);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('examGuard' in changes || 'examModeManual' in changes)) read();
  });
  read();
})();
