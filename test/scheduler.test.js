'use strict';

// Scheduler tests. Pinned to a DST-observing zone so the wall-clock math is exercised across transitions,
// independent of the machine's own time zone. (Node reads TZ lazily, so this must run before any Date use.)
process.env.TZ = 'America/New_York';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeReminder, defaultConfig } = require('../src/main/defaults');
const {
  TIMING,
  parseHM,
  dayKey,
  startOfTomorrow,
  isActiveAt,
  computeNext,
  snoozeNext,
  pruneStats,
  Scheduler,
} = require('../src/main/scheduler');

const MIN = 60 * 1000;
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const hm = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];

// Reference week: Mon 2026-10-05 … Sun 2026-10-11.
const MON = (h, mi = 0) => at(2026, 10, 5, h, mi);
const FRI = (h, mi = 0) => at(2026, 10, 9, h, mi);
const SAT = (h, mi = 0) => at(2026, 10, 10, h, mi);

function interval(every, from, to, days = EVERY_DAY, extra = {}) {
  const r = makeReminder('water', extra.id || 'water');
  r.schedule = { ...r.schedule, mode: 'interval', every, from, to, days };
  return Object.assign(r, extra);
}

function times(list, days = EVERY_DAY, extra = {}) {
  const r = makeReminder('call', extra.id || 'call');
  r.schedule = { ...r.schedule, mode: 'times', times: list, days };
  return Object.assign(r, extra);
}

/** Scheduler wired to a plain config object, a controllable clock and environment. */
function harness(reminders, { now = MON(10), runtime = {}, settings = {}, stats = {} } = {}) {
  const config = defaultConfig();
  config.reminders = reminders;
  config.runtime = { ...config.runtime, ...runtime };
  config.settings = { ...config.settings, ...settings };
  config.stats = stats;
  const h = {
    config,
    clock: now,
    env: { locked: false, idleSec: 0, busy: false, lastRunEndedAt: 0 },
    fired: [],
    changes: 0,
  };
  h.sched = new Scheduler({
    getData: () => config,
    now: () => h.clock,
    env: () => h.env,
    onFire: (r) => h.fired.push(r.id),
    onChange: () => h.changes++,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  h.next = (id) => config.runtime.next[id];
  h.advance = (ms) => (h.clock += ms);
  h.set = (ms) => (h.clock = ms);
  return h;
}

// -----------------------------------------------------------------------------------------------------------------

describe('time helpers', () => {
  it('parses HH:MM strictly', () => {
    assert.equal(parseHM('09:00'), 540);
    assert.equal(parseHM('9:05'), 545);
    assert.equal(parseHM('23:59'), 1439);
    for (const bad of ['24:00', '12:60', '1200', '', null, 930, '9:5', ' : ']) assert.equal(parseHM(bad), null, String(bad));
  });

  it('formats local day keys and the start of tomorrow', () => {
    assert.equal(dayKey(MON(23, 59)), '2026-10-05');
    assert.equal(dayKey(at(2026, 12, 31, 23, 30)), '2026-12-31');
    assert.equal(startOfTomorrow(MON(15, 40)), at(2026, 10, 6));
    assert.equal(startOfTomorrow(at(2026, 12, 31, 18)), at(2027, 1, 1));
  });
});

describe('computeNext - interval mode', () => {
  const water = interval(45, '09:00', '22:00');

  it('adds the interval inside the active window', () => {
    assert.equal(computeNext(water, MON(10)), MON(10, 45));
    assert.equal(computeNext(water, MON(21, 15)), at(2026, 10, 6, 9)); // lands on 22:00, which is exclusive
    assert.equal(hm(computeNext(water, MON(21, 14))), '10/5 21:59');
  });

  it('moves past the window end to the next window start', () => {
    assert.equal(computeNext(water, MON(21, 30)), at(2026, 10, 6, 9)); // 22:15 → Tue 09:00
  });

  it('moves a pre-window candidate to today’s window start', () => {
    assert.equal(computeNext(water, MON(7)), MON(9)); // 07:45 → 09:00
  });

  it('treats the window end as exclusive and the start as inclusive', () => {
    assert.equal(isActiveAt(water, MON(9)), true);
    assert.equal(isActiveAt(water, MON(22)), false);
    assert.equal(computeNext(interval(60, '09:00', '22:00'), MON(21)), at(2026, 10, 6, 9));
  });

  it('supports windows that cross midnight', () => {
    const night = interval(45, '22:00', '02:00');
    assert.equal(computeNext(night, MON(23, 30)), at(2026, 10, 6, 0, 15)); // still in Monday's window
    assert.equal(computeNext(night, at(2026, 10, 6, 1, 30)), at(2026, 10, 6, 22)); // 02:15 → 22:00
    assert.equal(computeNext(night, MON(12)), MON(22));
    assert.equal(isActiveAt(night, at(2026, 10, 6, 1, 59)), true);
    assert.equal(isActiveAt(night, at(2026, 10, 6, 2, 0)), false);
  });

  it('applies the day filter to the day a midnight-crossing window starts on', () => {
    const fridayNights = interval(45, '22:00', '02:00', [5]);
    assert.equal(computeNext(fridayNights, FRI(23, 30)), SAT(0, 15)); // Sat 00:15 belongs to Friday's window
    assert.equal(isActiveAt(fridayNights, SAT(1)), true);
    assert.equal(isActiveAt(fridayNights, at(2026, 10, 9, 1)), false); // Fri 01:00 = Thursday's window (off)
    assert.equal(computeNext(fridayNights, SAT(1, 30)), at(2026, 10, 16, 22)); // next Friday
  });

  it('treats from === to as all day', () => {
    const allDay = interval(60, '00:00', '00:00');
    assert.equal(computeNext(allDay, MON(23, 30)), at(2026, 10, 6, 0, 30));
    const allDayWeekdays = interval(60, '09:00', '09:00', WEEKDAYS);
    assert.equal(computeNext(allDayWeekdays, FRI(23, 30)), at(2026, 10, 12, 0, 0)); // Sat/Sun off → Mon 00:00
    assert.equal(isActiveAt(allDayWeekdays, MON(3)), true);
  });

  it('skips inactive days', () => {
    const weekdays = interval(45, '09:00', '22:00', WEEKDAYS);
    assert.equal(computeNext(weekdays, FRI(21, 50)), at(2026, 10, 12, 9)); // Fri 22:35 → Mon 09:00
    assert.equal(computeNext(weekdays, SAT(12)), at(2026, 10, 12, 9));
  });

  it('returns null for disabled or impossible schedules', () => {
    assert.equal(computeNext({ ...water, enabled: false }, MON(10)), null);
    assert.equal(computeNext(interval(45, '09:00', '22:00', []), MON(10)), null);
    assert.equal(computeNext(interval(0, '09:00', '22:00'), MON(10)), null);
    assert.equal(computeNext(null, MON(10)), null);
    assert.equal(computeNext(water, NaN), null);
  });

  it('keeps local wall-clock windows across DST transitions', () => {
    const springForward = computeNext(water, at(2026, 3, 7, 21, 30)); // Sat → Sun Mar 8 (02:00 → 03:00)
    assert.equal(new Date(springForward).getHours(), 9);
    assert.equal(dayKey(springForward), '2026-03-08');
    const fallBack = computeNext(water, at(2026, 10, 31, 21, 30)); // Sat → Sun Nov 1 (02:00 → 01:00)
    assert.equal(new Date(fallBack).getHours(), 9);
    assert.equal(dayKey(fallBack), '2026-11-01');
    // The interval itself is elapsed time: 01:30 EST + 60 min = 03:30 EDT on spring-forward night.
    const allDay = interval(60, '00:00', '00:00');
    assert.equal(hm(computeNext(allDay, at(2026, 3, 8, 1, 30))), '3/8 03:30');
  });
});

describe('computeNext - times mode', () => {
  it('returns the next listed time strictly after fromMs', () => {
    const r = times(['10:00', '16:00']);
    assert.equal(computeNext(r, MON(9)), MON(10));
    assert.equal(computeNext(r, MON(10)), MON(16)); // exactly at a slot → the following one
    assert.equal(computeNext(r, MON(16, 1)), at(2026, 10, 6, 10));
  });

  it('handles unsorted and duplicate times', () => {
    const r = times(['16:00', '10:00', '10:00', 'junk', '16:00']);
    assert.equal(computeNext(r, MON(9)), MON(10));
    assert.equal(computeNext(r, MON(10)), MON(16));
  });

  it('respects the day filter and wraps across the week', () => {
    const r = times(['19:30'], [1, 3]); // Mon + Wed
    assert.equal(computeNext(r, MON(20)), at(2026, 10, 7, 19, 30));
    assert.equal(computeNext(r, at(2026, 10, 7, 20)), at(2026, 10, 12, 19, 30));
  });

  it('ignores active hours (times are explicit)', () => {
    const r = times(['23:30']);
    r.schedule.from = '09:00';
    r.schedule.to = '17:00';
    assert.equal(computeNext(r, MON(12)), MON(23, 30));
  });

  it('never fires twice for times that collapse on a spring-forward day', () => {
    const r = times(['02:30', '03:30']); // 02:30 does not exist on Mar 8 → 03:30
    const first = computeNext(r, at(2026, 3, 8, 0, 0));
    assert.equal(hm(first), '3/8 03:30');
    assert.equal(hm(computeNext(r, first)), '3/9 02:30');
  });

  it('returns null without times', () => {
    assert.equal(computeNext(times([]), MON(9)), null);
  });
});

describe('snoozeNext', () => {
  it('is now + snooze inside the window', () => {
    const r = interval(45, '09:00', '22:00', EVERY_DAY, { snooze: 15 });
    assert.equal(snoozeNext(r, MON(10)), MON(10, 15));
  });

  it('respects active hours when the snooze lands past the window', () => {
    const r = interval(45, '09:00', '22:00', EVERY_DAY, { snooze: 15 });
    assert.equal(snoozeNext(r, MON(21, 55)), at(2026, 10, 6, 9));
  });

  it('never delays past the next regular slot', () => {
    const r = times(['10:00', '10:15'], EVERY_DAY, { snooze: 30 });
    assert.equal(snoozeNext(r, MON(10)), MON(10, 15));
    const short = interval(10, '09:00', '22:00', EVERY_DAY, { snooze: 30 });
    assert.equal(snoozeNext(short, MON(10)), MON(10, 10));
  });

  it('lets a fixed-time snooze run past midnight', () => {
    const r = times(['23:50'], [1], { snooze: 15 });
    assert.equal(snoozeNext(r, MON(23, 50)), at(2026, 10, 6, 0, 5));
  });
});

// -----------------------------------------------------------------------------------------------------------------

describe('Scheduler - startup restore', () => {
  it('keeps a persisted next in the future', () => {
    const h = harness([interval(45, '09:00', '22:00')], { runtime: { next: { water: MON(10, 30) } } });
    h.sched.restore();
    assert.equal(h.next('water'), MON(10, 30));
  });

  it('makes an overdue reminder due in 60 s when it is currently active', () => {
    const h = harness([interval(45, '09:00', '22:00')], { runtime: { next: { water: MON(8) } } });
    h.sched.restore();
    assert.equal(h.next('water'), MON(10) + TIMING.startupDelayMs);
  });

  it('re-plans an overdue reminder outside its window', () => {
    const h = harness([interval(45, '09:00', '22:00')], { now: MON(23), runtime: { next: { water: MON(21) } } });
    h.sched.restore();
    assert.equal(h.next('water'), at(2026, 10, 6, 9));
  });

  it('plans a never-scheduled reminder normally (first launch keeps the welcome promise)', () => {
    const h = harness([interval(45, '09:00', '22:00')]);
    h.sched.restore();
    assert.equal(h.next('water'), MON(10, 45));
  });

  it('catches up a recently missed fixed time, but skips a stale one', () => {
    const recent = harness([times(['09:30'])], { runtime: { next: { call: MON(9, 30) } } });
    recent.sched.restore();
    assert.equal(recent.next('call'), MON(10) + TIMING.startupDelayMs);

    const stale = harness([times(['07:00', '18:00'])], { runtime: { next: { call: MON(7) } } });
    stale.sched.restore();
    assert.equal(stale.next('call'), MON(18));
  });

  it('distrusts a next that is implausibly far away (clock jumped)', () => {
    const h = harness([interval(45, '09:00', '22:00')], { runtime: { next: { water: MON(10) + 30 * 24 * 3600e3 } } });
    h.sched.restore();
    assert.equal(h.next('water'), MON(10, 45));
  });

  it('clears disabled reminders, stale pauses and orphaned runtime', () => {
    const h = harness([interval(45, '09:00', '22:00', EVERY_DAY, { enabled: false })], {
      runtime: { next: { water: MON(11), ghost: MON(11) }, laterStreak: { ghost: 3 }, pausedUntil: MON(9) },
    });
    h.sched.restore();
    assert.deepEqual(h.config.runtime.next, { water: null });
    assert.deepEqual(h.config.runtime.laterStreak, {});
    assert.equal(h.config.runtime.pausedUntil, null);
  });
});

describe('Scheduler - firing and blocking', () => {
  let h;
  beforeEach(() => {
    h = harness([interval(45, '09:00', '22:00')], { now: MON(9, 30), runtime: { next: { water: MON(10) } } });
    h.sched.restore();
    h.set(MON(10));
  });

  it('fires once when due and never duplicates while in flight', () => {
    assert.equal(h.sched.tick(), 'water');
    h.advance(10e3);
    assert.equal(h.sched.tick(), null);
    h.advance(10 * MIN);
    assert.equal(h.sched.tick(), null);
    assert.deepEqual(h.fired, ['water']);
  });

  it('does not fire early', () => {
    h.set(MON(9, 59));
    assert.equal(h.sched.tick(), null);
  });

  for (const [name, block, unblock] of [
    ['paused', (x) => (x.config.runtime.pausedUntil = MON(11)), (x) => x.set(MON(11))],
    ['screen locked', (x) => (x.env.locked = true), (x) => (x.env.locked = false)],
    ['user idle', (x) => (x.env.idleSec = 6 * 60), (x) => (x.env.idleSec = 3)],
    ['another run showing', (x) => (x.env.busy = true), (x) => (x.env.busy = false)],
  ]) {
    it(`holds a due reminder while ${name}, then fires it exactly once`, () => {
      block(h);
      for (let i = 0; i < 30; i++) {
        assert.equal(h.sched.tick(), null);
        h.advance(10e3);
      }
      assert.equal(h.next('water'), MON(10), 'stays due (coalesced), not re-planned');
      unblock(h);
      assert.equal(h.sched.tick(), 'water');
      assert.equal(h.sched.tick(), null);
      assert.deepEqual(h.fired, ['water']);
    });
  }

  it('ignores idleness when idle-aware is off', () => {
    h.config.settings.idleAware = false;
    h.env.idleSec = 3600;
    assert.equal(h.sched.tick(), 'water');
  });

  it('waits 20 s after the previous run ended', () => {
    h.env.lastRunEndedAt = MON(10) - 5e3;
    assert.equal(h.sched.tick(), null);
    h.set(MON(10) + 15e3);
    assert.equal(h.sched.tick(), 'water');
  });

  it('expires a pause and announces the change', () => {
    h.config.runtime.pausedUntil = MON(10, 5);
    h.sched.tick();
    h.set(MON(10, 5));
    const before = h.changes;
    assert.equal(h.sched.tick(), 'water');
    assert.equal(h.config.runtime.pausedUntil, null);
    assert.ok(h.changes > before);
  });

  it('skips an interval reminder unblocked outside its window', () => {
    h.env.idleSec = 9999;
    h.set(MON(21, 50));
    h.sched.tick();
    h.set(MON(22, 30));
    h.env.idleSec = 0;
    assert.equal(h.sched.tick(), null);
    assert.equal(h.next('water'), at(2026, 10, 6, 9));
    assert.deepEqual(h.fired, []);
  });

  it('still fires a run that was due inside the window when the tick lands just after it closes', () => {
    h.config.runtime.next.water = at(2026, 10, 5, 21, 59, 55);
    h.set(MON(22) + 5e3);
    assert.equal(h.sched.tick(), 'water');
  });

  it('skips fixed-time reminders overdue by more than 2 h, fires those within', () => {
    const t = harness([times(['09:00', '18:00'])], { now: MON(8), runtime: { next: { call: MON(9) } } });
    t.sched.restore();
    t.env.locked = true;
    t.set(MON(10, 59));
    t.sched.tick();
    t.env.locked = false;
    assert.equal(t.sched.tick(), 'call');

    const late = harness([times(['09:00', '18:00'])], { now: MON(8), runtime: { next: { call: MON(9) } } });
    late.sched.restore();
    late.env.locked = true;
    late.set(MON(11, 1));
    late.sched.tick();
    late.env.locked = false;
    assert.equal(late.sched.tick(), null);
    assert.equal(late.next('call'), MON(18));
  });

  it('fires several due reminders one at a time, most overdue first', () => {
    const m = harness(
      [interval(45, '09:00', '22:00', EVERY_DAY, { id: 'a' }), interval(30, '09:00', '22:00', EVERY_DAY, { id: 'b' })],
      { now: MON(9, 30), runtime: { next: { a: MON(9, 50), b: MON(9, 40) } } },
    );
    m.sched.restore();
    m.set(MON(10));
    m.env.busy = true;
    m.sched.tick();
    m.env.busy = false;
    assert.equal(m.sched.tick(), 'b');
    assert.equal(m.sched.tick(), null, 'one visit at a time');
    m.sched.resolve('b', 'yes');
    m.env.lastRunEndedAt = m.clock;
    assert.equal(m.sched.tick(), null, 'quiet gap after the visit');
    m.advance(TIMING.runGapMs);
    assert.equal(m.sched.tick(), 'a');
  });

  it('recovers from a run that never reported back', () => {
    assert.equal(h.sched.tick(), 'water');
    h.advance(TIMING.inflightTtlMs + 1);
    assert.equal(h.sched.tick(), 'water');
  });

  it('plans enabled reminders that have no next yet', () => {
    h.config.runtime.next = {};
    h.sched.tick();
    assert.equal(h.next('water'), MON(10, 45));
  });
});

describe('Scheduler - outcomes', () => {
  let h;
  const today = () => h.config.stats.water[dayKey(h.clock)];
  beforeEach(() => {
    h = harness([interval(45, '09:00', '22:00', EVERY_DAY, { snooze: 15 })], {
      now: MON(9, 30),
      runtime: { next: { water: MON(10) } },
    });
    h.sched.restore();
    h.set(MON(10));
    assert.equal(h.sched.tick(), 'water');
    h.advance(30e3);
  });

  it('yes → stats.yes++, streak reset, next = computeNext(now)', () => {
    h.config.runtime.laterStreak.water = 2;
    assert.equal(h.sched.resolve('water', 'yes'), true);
    assert.deepEqual(today(), { yes: 1, later: 0, missed: 0 });
    assert.equal(h.config.runtime.laterStreak.water, undefined);
    assert.equal(h.next('water'), MON(10, 45) + 30e3);
    assert.equal(h.sched.countToday('water'), 1);
  });

  it('later → stats.later++, streak++, next = now + snooze', () => {
    h.sched.resolve('water', 'later');
    assert.deepEqual(today(), { yes: 0, later: 1, missed: 0 });
    assert.equal(h.sched.streakFor('water'), 1);
    assert.equal(h.next('water'), MON(10, 15) + 30e3);
  });

  it('timeout → stats.missed++, streak++, snoozed', () => {
    h.sched.resolve('water', 'timeout');
    assert.deepEqual(today(), { yes: 0, later: 0, missed: 1 });
    assert.equal(h.sched.streakFor('water'), 1);
    assert.equal(h.next('water'), MON(10, 15) + 30e3);
  });

  it('dismiss → no stats, next = computeNext(now)', () => {
    h.sched.resolve('water', 'dismiss');
    assert.equal(h.config.stats.water, undefined);
    assert.equal(h.next('water'), MON(10, 45) + 30e3);
  });

  it('abort (lost run) → no stats, retried shortly', () => {
    h.sched.resolve('water', 'abort');
    assert.equal(h.config.stats.water, undefined);
    assert.equal(h.next('water'), MON(10) + 30e3 + TIMING.retryMs);
  });

  it('escalates the later-streak across consecutive answers and resets on yes', () => {
    for (let i = 1; i <= 3; i++) {
      h.sched.resolve('water', 'later');
      assert.equal(h.sched.streakFor('water'), i);
      h.set(h.next('water'));
      assert.equal(h.sched.tick(), 'water');
    }
    h.sched.resolve('water', 'yes');
    assert.equal(h.sched.streakFor('water'), 0);
  });

  it('starts each day with a clean later-streak', () => {
    h.sched.resolve('water', 'later');
    h.sched.resolve('water', 'later');
    assert.equal(h.sched.streakFor('water'), 2);
    h.set(at(2026, 10, 6, 9));
    assert.equal(h.sched.streakFor('water'), 0);
    h.sched.tick();
    h.sched.resolve('water', 'later');
    assert.equal(h.sched.streakFor('water'), 1);
  });

  it('ignores unknown reminders and outcomes', () => {
    assert.equal(h.sched.resolve('ghost', 'yes'), false);
    assert.equal(h.sched.resolve('water', 'explode'), false);
    assert.equal(h.config.stats.water, undefined);
  });

  it('keeps a disabled reminder unscheduled after its outcome', () => {
    h.config.reminders[0].enabled = false;
    h.sched.resolve('water', 'later');
    assert.equal(h.next('water'), null);
  });
});

describe('Scheduler - manual runs (summon, tray, demo)', () => {
  it('summon picks the reminder with the soonest next run', () => {
    const h = harness(
      [
        interval(45, '09:00', '22:00', EVERY_DAY, { id: 'a' }),
        interval(45, '09:00', '22:00', EVERY_DAY, { id: 'b' }),
        interval(45, '09:00', '22:00', EVERY_DAY, { id: 'c', enabled: false }),
      ],
      { runtime: { next: { a: MON(11), b: MON(10, 20), c: MON(10, 5) } } },
    );
    h.sched.restore();
    assert.equal(h.sched.soonest().id, 'b');
    h.sched.begin('b');
    assert.equal(h.sched.soonest().id, 'a');
  });

  it('a manual run blocks the scheduled one for the same reminder', () => {
    const h = harness([interval(45, '09:00', '22:00')], { runtime: { next: { water: MON(10, 1) } } });
    h.sched.restore();
    h.sched.begin('water');
    h.set(MON(10, 2));
    assert.equal(h.sched.tick(), null);
  });

  it('YES on a fixed-time reminder before today’s slot counts as that slot', () => {
    const h = harness([times(['19:30'])], { now: MON(14), runtime: { next: { call: MON(19, 30) } } });
    h.sched.restore();
    h.sched.begin('call');
    h.sched.resolve('call', 'yes');
    assert.equal(h.next('call'), at(2026, 10, 6, 19, 30));
  });

  it('…but not tomorrow’s slot', () => {
    const h = harness([times(['09:30'])], { now: MON(20), runtime: { next: { call: at(2026, 10, 6, 9, 30) } } });
    h.sched.restore();
    h.sched.begin('call');
    h.sched.resolve('call', 'yes');
    assert.equal(h.next('call'), at(2026, 10, 6, 9, 30));
  });

  it('dismissing a summoned reminder keeps its schedule', () => {
    const h = harness([interval(45, '09:00', '22:00')], { runtime: { next: { water: MON(10, 30) } } });
    h.sched.restore();
    h.sched.begin('water');
    h.sched.resolve('water', 'dismiss');
    assert.equal(h.next('water'), MON(10, 30));
  });

  it('YES on a summoned interval reminder restarts the interval from now', () => {
    const h = harness([interval(45, '09:00', '22:00')], { runtime: { next: { water: MON(10, 30) } } });
    h.sched.restore();
    h.sched.begin('water');
    h.sched.resolve('water', 'yes');
    assert.equal(h.next('water'), MON(10, 45));
  });
});

describe('Scheduler - editing, deleting, pausing', () => {
  let h;
  beforeEach(() => {
    h = harness([interval(45, '09:00', '22:00')], {
      runtime: { next: { water: MON(10, 30) }, laterStreak: { water: 2 } },
      stats: { water: { '2026-10-05': { yes: 2, later: 1, missed: 0 } } },
    });
    h.sched.restore();
  });

  it('recomputes next from now when the schedule changes', () => {
    const prev = h.config.reminders[0];
    const edited = { ...prev, schedule: { ...prev.schedule, every: 20 } };
    h.config.reminders[0] = edited;
    assert.equal(h.sched.reminderSaved(prev, edited), true);
    assert.equal(h.next('water'), MON(10, 20));
  });

  it('keeps next when only texts change', () => {
    const prev = h.config.reminders[0];
    const edited = { ...prev, title: 'Hydrate', schedule: { ...prev.schedule, days: [...prev.schedule.days] } };
    assert.equal(h.sched.reminderSaved(prev, edited), false);
    assert.equal(h.next('water'), MON(10, 30));
  });

  it('disabling clears next; re-enabling plans from now', () => {
    const prev = h.config.reminders[0];
    const off = { ...prev, enabled: false };
    h.sched.reminderSaved(prev, off);
    assert.equal(h.next('water'), null);
    h.set(MON(12));
    h.sched.reminderSaved(off, { ...off, enabled: true });
    assert.equal(h.next('water'), MON(12, 45));
  });

  it('plans a newly created reminder', () => {
    const fresh = times(['18:00'], EVERY_DAY, { id: 'new-one' });
    h.config.reminders.push(fresh);
    h.sched.reminderSaved(null, fresh);
    assert.equal(h.next('new-one'), MON(18));
  });

  it('deleting removes runtime and streak but keeps stats', () => {
    h.sched.begin('water');
    h.config.reminders = [];
    h.sched.reminderRemoved('water');
    assert.equal('water' in h.config.runtime.next, false);
    assert.equal('water' in h.config.runtime.laterStreak, false);
    assert.equal(h.sched.isInflight('water'), false);
    assert.deepEqual(h.config.stats.water['2026-10-05'], { yes: 2, later: 1, missed: 0 });
    assert.equal(h.sched.resolve('water', 'yes'), false, 'late outcome of a deleted reminder is ignored');
  });

  it('pauses until tomorrow and resumes on its own', () => {
    h.sched.setPause(startOfTomorrow(h.clock));
    assert.equal(h.config.runtime.pausedUntil, at(2026, 10, 6));
    h.set(MON(10, 30));
    assert.equal(h.sched.tick(), null);
    assert.equal(h.sched.blockedBy(), 'paused');
    h.set(at(2026, 10, 6, 0, 0, 5));
    assert.equal(h.sched.tick(), null, 'water was due during the pause but its window is closed at midnight');
    assert.equal(h.config.runtime.pausedUntil, null);
    assert.equal(h.next('water'), at(2026, 10, 6, 9));
    h.set(at(2026, 10, 6, 9));
    assert.equal(h.sched.tick(), 'water');
  });

  it('validates pause input', () => {
    assert.equal(h.sched.setPause(MON(9)), null, 'past → resume');
    assert.equal(h.sched.setPause(MON(10) + 30 * 24 * 3600e3), MON(10) + TIMING.maxPauseMs, 'capped');
    assert.equal(h.sched.setPause('soon'), MON(10) + TIMING.maxPauseMs, 'garbage leaves it unchanged');
    assert.equal(h.sched.setPause(null), null);
  });
});

describe('pruneStats', () => {
  it('keeps the last 60 local days and drops empty reminders', () => {
    const stats = {
      water: { '2026-10-05': { yes: 1, later: 0, missed: 0 }, '2026-08-07': { yes: 1, later: 0, missed: 0 }, '2026-08-06': { yes: 9, later: 0, missed: 0 } },
      old: { '2025-01-01': { yes: 1, later: 0, missed: 0 } },
    };
    assert.equal(pruneStats(stats, MON(12)), true);
    assert.deepEqual(Object.keys(stats), ['water']);
    assert.deepEqual(Object.keys(stats.water).sort(), ['2026-08-07', '2026-10-05']);
    assert.equal(pruneStats(stats, MON(12)), false);
  });
});
