(() => {
  if (location.pathname !== '/' || !document.documentElement.hasAttribute('data-icd')) return;

  const planner = document.querySelector('#dashboard-planner');
  const actions = document.querySelector('#dashboard_header_container .ic-Dashboard-header__actions');
  if (!planner || !actions) return;

  const button = document.createElement('button');
  button.id = 'icd-expand-completed';
  button.type = 'button';
  button.className = 'Button';
  button.textContent = '완료한 항목 펼치기';
  button.addEventListener('click', () => {
    if (planner.style.display === 'none') return;
    planner.querySelectorAll('.planner-completed-items button[aria-expanded="false"]')
      .forEach(toggle => toggle.click());
  });
  actions.insertBefore(button, actions.querySelector('#DashboardOptionsMenu_Container'));

  function dayDate(day, today) {
    const heading = day.querySelector('h2');
    if (!heading) return null;
    const source = heading.querySelector('time[datetime]')?.getAttribute('datetime')
      || heading.getAttribute('data-date') || day.getAttribute('data-date')
      || heading.getAttribute('data-datetime') || day.getAttribute('data-datetime');
    if (source) {
      const iso = source.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (iso) return validDate(+iso[1], +iso[2], +iso[3]);
    }

    const parts = [...heading.children].map(el => el.textContent.trim());
    const label = parts[0] || heading.textContent.trim();
    const detail = parts[1] || heading.textContent.trim();
    if (!/\d+월/.test(detail)) {
      if (label.includes('오늘')) return new Date(today);
      if (label.includes('내일')) return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      return null;
    }
    const match = detail.match(/(\d{1,2})월\s*(\d{1,2})일?(?:\s*,?\s*(\d{4})년?)?/);
    if (!match) return null;
    const month = +match[1], date = +match[2];
    if (match[3]) return validDate(+match[3], month, date);
    if (label.includes('오늘')) return validDate(today.getFullYear(), month, date);
    if (label.includes('내일')) {
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      return validDate(tomorrow.getFullYear(), month, date);
    }
    return [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]
      .map(year => validDate(year, month, date)).filter(Boolean)
      .sort((a, b) => Math.abs(a - today) - Math.abs(b - today))[0] || null;
  }

  function validDate(year, month, day) {
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date : null;
  }

  function updateBadges() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    planner.querySelectorAll('.planner-day').forEach(day => {
      const heading = day.querySelector('h2');
      if (!heading) return;
      const existing = heading.querySelector('[data-icd-day-badge]');
      const items = [...day.querySelectorAll('.planner-item input[type="checkbox"], .planner-item [role="checkbox"]')];
      const hasIncomplete = items.some(item => item.getAttribute('aria-checked') !== 'true' && !item.checked);
      const date = dayDate(day, today);
      const difference = date && Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - todayUtc) / 86400000);
      if (!hasIncomplete || difference === null || difference < 0 || difference > 7) {
        existing?.remove();
        return;
      }
      const label = difference === 0 ? '오늘' : `D-${difference}`;
      const level = difference <= 3 ? 'soon' : 'warning';
      const badge = existing || document.createElement('span');
      badge.dataset.icdDayBadge = level;
      badge.textContent = label;
      if (!existing) heading.append(badge);
    });
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestIdleCallback(() => {
      pending = false;
      updateBadges();
    });
  }
  new MutationObserver(schedule).observe(planner, { childList: true, subtree: true });
  planner.addEventListener('change', event => {
    if (event.target.matches('.planner-item input[type="checkbox"], .planner-item [role="checkbox"]')) schedule();
  });
  schedule();
})();
