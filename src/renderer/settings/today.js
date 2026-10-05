// Today section: per-reminder progress vs goal, a 7-day yes/later chart and the current streak.
import { $, h, ICON, dayKey } from './ui.js';

function streak(byDay = {}, goal) {
  const hit = (k) => {
    const v = byDay[k];
    return !!v && (goal ? v.yes >= goal : v.yes >= 1);
  };
  const d = new Date();
  if (!hit(dayKey(d))) d.setDate(d.getDate() - 1); // today is still in progress
  let n = 0;
  while (hit(dayKey(d)) && n < 3660) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

// Static, number-only SVG meters (no user text inside).
function glassMeter(frac, uid) {
  const level = 86 - 66 * frac;
  return `<svg viewBox="0 0 80 96" aria-hidden="true">
    <defs><clipPath id="g-clip-${uid}"><path d="M14 12h52l-6 74a6 6 0 0 1-6 5.5H26A6 6 0 0 1 20 86z"/></clipPath></defs>
    <g clip-path="url(#g-clip-${uid})">
      <rect x="0" y="0" width="80" height="96" class="glass-bg"/>
      <path class="glass-water" d="M0 ${level}q10 -4 20 0t20 0t20 0t20 0V96H0z"/>
    </g>
    <path class="glass-rim" d="M14 12h52l-6 74a6 6 0 0 1-6 5.5H26A6 6 0 0 1 20 86z"/>
    <path class="glass-shine" d="M22 22l4 56"/>
  </svg>`;
}
function ringMeter(frac) {
  const c = 2 * Math.PI * 36;
  return `<svg viewBox="0 0 88 88" aria-hidden="true">
    <circle cx="44" cy="44" r="36" class="ring-bg"/>
    <circle cx="44" cy="44" r="36" class="ring-fg" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 44 44)"/>
  </svg>`;
}

export function mountToday(root, app) {
  const list = $('#today-list', root);
  let active = false;

  function render() {
    if (!active) return;
    const { reminders, stats } = app.state;
    $('#today-date', root).textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    if (!reminders.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        h('div', { class: 'empty-art', 'aria-hidden': 'true', text: '🌱' }),
        h('h2', { text: 'Nothing to track yet' }),
        h('p', { text: 'Add a reminder and your progress will grow here.' })));
      return;
    }
    const now = new Date();
    const days = Array.from({ length: 7 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + i));
    list.replaceChildren(...reminders.map((r, idx) => {
      const byDay = stats[r.id] || {};
      const today = byDay[dayKey()] || { yes: 0, later: 0 };
      const goal = r.goal || 0;
      const frac = goal ? Math.min(1, today.yes / goal) : today.yes ? 1 : 0;
      const water = goal && (r.prop === 'bottle' || r.prop === 'glass');
      const n = streak(byDay, goal);
      const week = days.map((d) => ({ d, v: byDay[dayKey(d)] || { yes: 0, later: 0 } }));
      const max = Math.max(goal, 1, ...week.map(({ v }) => v.yes + v.later));

      const meter = h('div', { class: `meter ${water ? 'glass' : 'ring'}${goal && today.yes >= goal ? ' done' : ''}`, html: water ? glassMeter(frac, idx) : ringMeter(frac) },
        h('span', { class: 'meter-num' }, h('b', { text: String(today.yes) }), goal ? h('small', { text: `/ ${goal}` }) : null));

      const bars = h('div', { class: 'week', role: 'img', 'aria-label': `Last 7 days for ${r.title}: ${week.map(({ d, v }) => `${d.toLocaleDateString([], { weekday: 'short' })} ${v.yes} yes, ${v.later} later`).join('; ')}` },
        ...week.map(({ d, v }, i) => h('div', { class: `wk${i === 6 ? ' is-today' : ''}`, title: `${d.toLocaleDateString([], { weekday: 'long' })}: ${v.yes} yes · ${v.later} later` },
          h('div', { class: 'wk-bar' },
            goal ? h('i', { class: 'wk-goal', style: `bottom:${(goal / max) * 100}%` }) : null,
            h('span', { class: 'wk-yes', style: `height:${(v.yes / max) * 100}%` }),
            h('span', { class: 'wk-later', style: `height:${(v.later / max) * 100}%` })),
          h('span', { class: 'wk-day', text: d.toLocaleDateString([], { weekday: 'narrow' }) }))));

      const status = goal
        ? today.yes >= goal ? 'Goal reached today' : `${goal - today.yes} to go today`
        : today.yes ? `${today.yes} done today` : 'Not yet today';
      return h('article', { class: `today-card${r.enabled ? '' : ' off'}` },
        meter,
        h('div', { class: 'today-info' },
          h('h3', {}, h('span', { class: 'today-emoji', text: r.emoji, 'aria-hidden': 'true' }), h('span', { text: r.title })),
          h('p', { class: 'today-status', text: status }),
          h('span', { class: `streak${n ? '' : ' none'}`, html: ICON.flame }, h('span', { text: n ? `${n}-day streak` : 'Start a streak today' })),
          today.later ? h('p', { class: 'muted small', text: `Snoozed ${today.later}× today` }) : null),
        h('div', { class: 'today-chart' }, bars,
          h('div', { class: 'legend' }, h('span', { class: 'lg yes', text: 'Yes' }), h('span', { class: 'lg later', text: 'Later' }))));
    }));
  }

  app.onState(render);
  return {
    activate() {
      active = true;
      render();
    },
    deactivate() {
      active = false;
    },
  };
}
