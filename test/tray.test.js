'use strict';

// Tray status text (pure helpers; plain Node resolves require('electron') to a path string, which is fine here).
process.env.TZ = 'America/New_York';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { makeReminder } = require('../src/main/defaults');
const { status, relative } = require('../src/main/tray');

const at = (h, mi = 0, d = 5) => new Date(2026, 9, d, h, mi).getTime();
const NOW = at(10);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function state({ next = {}, pausedUntil = null, enabled = true } = {}) {
  const water = { ...makeReminder('water', 'water'), enabled };
  const call = makeReminder('call', 'call');
  return { reminders: [water, call], runtime: { pausedUntil, next, laterStreak: {}, onboarded: true } };
}

describe('tray relative time', () => {
  it('counts minutes up, never showing "in 0 min"', () => {
    assert.equal(relative(NOW + 23 * 60000, NOW), 'in 23 min');
    assert.equal(relative(NOW + 10e3, NOW), 'in 1 min');
    assert.equal(relative(NOW - 5e3, NOW), 'due now');
  });

  it('switches to hours, then clock times', () => {
    assert.equal(relative(NOW + 65 * 60000, NOW), 'in 1 h 5 min');
    assert.equal(relative(NOW + 120 * 60000, NOW), 'in 2 h');
    assert.equal(relative(at(19, 30), NOW), `at ${clock(at(19, 30))}`);
    assert.equal(relative(at(9, 0, 6), NOW), `tomorrow ${clock(at(9, 0, 6))}`);
    assert.match(relative(at(9, 0, 8), NOW), /^Thu /);
  });
});

describe('tray status line', () => {
  it('names the soonest enabled reminder', () => {
    const s = status(state({ next: { water: NOW + 23 * 60000, call: NOW + 5 * 60000 } }), NOW);
    assert.equal(s.text, 'Next: Call someone in 5 min');
    assert.equal(s.paused, false);
  });

  it('ignores disabled reminders', () => {
    const s = status(state({ next: { water: NOW + 60000, call: NOW + 23 * 60000 }, enabled: false }), NOW);
    assert.equal(s.text, 'Next: Call someone in 23 min');
  });

  it('reports pauses', () => {
    assert.equal(status(state({ pausedUntil: at(15, 40) }), NOW).text, `Paused until ${clock(at(15, 40))}`);
    assert.equal(status(state({ pausedUntil: at(0, 0, 6) }), NOW).text, 'Paused until tomorrow');
    assert.equal(status(state({ pausedUntil: at(9, 0) }), NOW).paused, false, 'an expired pause is ignored');
  });

  it('handles nothing scheduled', () => {
    const none = state();
    none.reminders.forEach((r) => (r.enabled = false));
    assert.equal(status(none, NOW).text, 'No reminders on');
    assert.equal(status(state(), NOW).text, 'Nothing scheduled');
  });
});
