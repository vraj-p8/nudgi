'use strict';

// Nudgi scheduling.
//
// Two layers:
//  - Pure helpers (computeNext, isActiveAt, snoozeNext, …) that take explicit timestamps. All local wall-clock
//    math goes through Date setters (never "+ 24h"), so DST shifts and month/year rollovers are the platform's job.
//  - Scheduler: a small state machine over the live config ({ settings, reminders, stats, runtime }) with an
//    injected clock and environment probe, so every rule is unit-testable without Electron.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const TIMING = Object.freeze({
  tickMs: 10 * 1000, // wall-clock poll; absolute comparisons make it robust to sleep/resume
  startupDelayMs: MINUTE, // overdue at launch → give the desktop a minute to settle
  runGapMs: 20 * 1000, // quiet time between the buddy leaving and the next scheduled visit
  idleBlockSec: 5 * 60, // idle-aware: hold reminders while the user has been away this long
  windowGraceMs: MINUTE, // due inside its window but the tick landed just after it closed → still fire
  timesStaleMs: 2 * HOUR, // fixed-time reminders overdue longer than this are skipped, not shown late
  retryMs: 2 * MINUTE, // run lost before the user answered (renderer crash / force-hide) → retry soon
  inflightTtlMs: 15 * MINUTE, // safety net if a run never reports back
  maxLeadMs: 8 * 24 * HOUR, // a persisted `next` further out than this is bogus (clock jumped back)
  maxPauseMs: 7 * 24 * HOUR,
  statsKeepDays: 60,
});

const OUTCOMES = Object.freeze(['yes', 'later', 'timeout', 'dismiss', 'abort']);
const SCAN_DAYS = 9; // one full week plus slack for windows that cross midnight

// ---------------------------------------------------------------------------------------------------------------
// Local-time primitives

const pad2 = (n) => String(n).padStart(2, '0');

/** 'HH:MM' (or 'H:MM') → minutes after midnight, or null. */
function parseHM(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Same wall-clock time `days` calendar days later (DST-safe). */
function addDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Local midnight `offset` days from the day containing `ms`. */
function dayStart(ms, offset = 0) {
  return startOfDay(addDays(startOfDay(ms), offset));
}

/** The instant `minutes` after local midnight of `dayMs` (non-existent DST times roll forward). */
function atMinutes(dayMs, minutes) {
  const d = new Date(dayMs);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

function startOfTomorrow(ms) {
  return dayStart(ms, 1);
}

/** Local calendar date key 'YYYY-MM-DD'. */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Schedule math

/** Normalises a reminder schedule into a lookup-friendly shape; null when it can never fire. */
function readSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  const rawDays = Array.isArray(schedule.days) ? schedule.days : [];
  const days = new Set(rawDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (!days.size) return null;

  if (schedule.mode === 'times') {
    const rawTimes = Array.isArray(schedule.times) ? schedule.times : [];
    const times = [...new Set(rawTimes.map(parseHM).filter((t) => t !== null))].sort((a, b) => a - b);
    return times.length ? { mode: 'times', days, times } : null;
  }

  const every = Number(schedule.every);
  if (!Number.isFinite(every) || every < 1) return null;
  const from = parseHM(schedule.from);
  const to = parseHM(schedule.to);
  const allDay = from === null || to === null || from === to;
  return { mode: 'interval', days, every, from, to, allDay };
}

/** Active window that STARTS on local day `day` (a midnight), or null if that day is off. */
function windowOn(s, day) {
  if (!s.days.has(new Date(day).getDay())) return null;
  if (s.allDay) return { start: day, end: dayStart(day, 1) };
  const start = atMinutes(day, s.from);
  const end = atMinutes(s.to > s.from ? day : dayStart(day, 1), s.to); // to <= from → crosses midnight
  return end > start ? { start, end } : null;
}

function inWindow(s, ms) {
  // A window crossing midnight that started yesterday may still be open.
  for (const offset of [-1, 0]) {
    const w = windowOn(s, dayStart(ms, offset));
    if (w && ms >= w.start && ms < w.end) return true;
  }
  return false;
}

function nextWindowStart(s, ms) {
  for (let i = 0; i <= SCAN_DAYS; i++) {
    const w = windowOn(s, dayStart(ms, i));
    if (w && w.start > ms) return w.start;
  }
  return null;
}

/** `ms` if it is inside an active window, otherwise the start of the next one. */
function alignToWindow(s, ms) {
  return inWindow(s, ms) ? ms : nextWindowStart(s, ms);
}

/**
 * Is `ms` inside the reminder's active hours? Interval mode: inside [from, to) on an active day (windows may cross
 * midnight; from === to means the whole day). Times mode: the day itself is active.
 */
function isActiveAt(reminder, ms) {
  const s = reminder && readSchedule(reminder.schedule);
  if (!s) return false;
  return s.mode === 'times' ? s.days.has(new Date(ms).getDay()) : inWindow(s, ms);
}

/**
 * Next fire time strictly after `fromMs`, or null.
 * interval: fromMs + every, moved to the next active window start when it lands outside the window.
 * times:    the earliest listed time strictly after fromMs on an active day.
 */
function computeNext(reminder, fromMs) {
  if (!reminder || reminder.enabled === false || !Number.isFinite(fromMs)) return null;
  const s = readSchedule(reminder.schedule);
  if (!s) return null;

  if (s.mode === 'interval') return alignToWindow(s, fromMs + s.every * MINUTE);

  for (let i = 0; i <= SCAN_DAYS; i++) {
    const day = dayStart(fromMs, i);
    if (!s.days.has(new Date(day).getDay())) continue;
    // min() rather than first match: on a spring-forward day "02:30" can map later than "03:00".
    let best = null;
    for (const t of s.times) {
      const at = atMinutes(day, t);
      if (at > fromMs && (best === null || at < best)) best = at;
    }
    if (best !== null) return best;
  }
  return null;
}

const earliest = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

/** now + delay (respecting active hours in interval mode), but never later than the next regular slot. */
function delayedNext(reminder, now, delayMs) {
  if (!reminder || reminder.enabled === false) return null;
  const s = readSchedule(reminder.schedule);
  if (!s) return null;
  const delayed = s.mode === 'interval' ? alignToWindow(s, now + delayMs) : now + delayMs;
  return earliest(delayed, computeNext(reminder, now));
}

/** Where a "Remind me later" / timeout lands. */
function snoozeNext(reminder, now) {
  const snooze = Number(reminder && reminder.snooze);
  const minutes = Number.isFinite(snooze) && snooze >= 1 ? snooze : 15;
  return delayedNext(reminder, now, minutes * MINUTE);
}

function sameSchedule(a, b) {
  if (!a || !b) return a === b;
  const list = (v) => (Array.isArray(v) ? v.join(',') : '');
  return (
    a.mode === b.mode &&
    a.every === b.every &&
    a.from === b.from &&
    a.to === b.to &&
    list(a.times) === list(b.times) &&
    list(a.days) === list(b.days)
  );
}

/** Drops per-day stats older than `keepDays` (today included). Returns true when anything was removed. */
function pruneStats(stats, now, keepDays = TIMING.statsKeepDays) {
  if (!stats || typeof stats !== 'object') return false;
  const oldest = dayKey(dayStart(now, -(keepDays - 1)));
  let changed = false;
  for (const id of Object.keys(stats)) {
    const days = stats[id];
    for (const day of Object.keys(days)) {
      if (day < oldest) {
        delete days[day];
        changed = true;
      }
    }
    if (!Object.keys(days).length) {
      delete stats[id];
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------
// Scheduler

class Scheduler {
  /**
   * @param {object} o
   * @param {() => {settings, reminders, stats, runtime}} o.getData  live config (mutated in place)
   * @param {() => number} [o.now]                                   injected clock
   * @param {() => {locked?, idleSec?, busy?, lastRunEndedAt?}} [o.env]  environment probe
   * @param {(reminder, info) => void} [o.onFire]                    a reminder is due and nothing blocks it
   * @param {(reason: string) => void} [o.onChange]                  runtime/stats changed → persist + broadcast
   * @param {{setInterval, clearInterval}} [o.timers]
   */
  constructor({ getData, now = Date.now, env = () => ({}), onFire = () => {}, onChange = () => {}, timers } = {}) {
    if (typeof getData !== 'function') throw new TypeError('Scheduler needs getData()');
    this.getData = getData;
    this.now = now;
    this.env = env;
    this.onFire = onFire;
    this.onChange = onChange;
    this.timers = timers || { setInterval, clearInterval };
    this.inflight = new Map(); // reminderId → { since, manual }; set while a run is queued or on screen
    this.timer = null;
    this.lastDay = null;
  }

  start() {
    this.stop();
    this.restore();
    this.timer = this.timers.setInterval(() => this.tick(), TIMING.tickMs);
    return this;
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /** Startup: keep future `next`s, re-plan missing or overdue ones, drop runtime of deleted reminders. */
  restore() {
    const now = this.now();
    const data = this.getData();
    const { reminders, runtime } = data;
    const next = {};
    for (const r of reminders) next[r.id] = this.startupNext(r, runtime.next[r.id], now);
    runtime.next = next;
    for (const id of Object.keys(runtime.laterStreak)) {
      if (!reminders.some((r) => r.id === id)) delete runtime.laterStreak[id];
    }
    if (runtime.pausedUntil !== null && runtime.pausedUntil <= now) runtime.pausedUntil = null;
    pruneStats(data.stats, now);
    this.lastDay = dayKey(now);
    this.onChange('restore');
  }

  startupNext(r, prev, now) {
    if (!r.enabled) return null;
    const fresh = computeNext(r, now);
    if (!Number.isFinite(prev)) return fresh; // never planned (first launch): keep the welcome's promise
    if (prev > now) return prev - now <= TIMING.maxLeadMs ? prev : fresh;
    // Overdue while the app was not running.
    const catchUp = r.schedule.mode === 'times' ? now - prev <= TIMING.timesStaleMs : isActiveAt(r, now);
    return catchUp ? now + TIMING.startupDelayMs : fresh;
  }

  /** One scheduling pass. Fires at most one reminder; returns its id or null. */
  tick() {
    const now = this.now();
    const data = this.getData();
    const { runtime } = data;
    let changed = false;

    if (runtime.pausedUntil !== null && runtime.pausedUntil <= now) {
      runtime.pausedUntil = null;
      changed = true;
    }
    for (const [id, flight] of this.inflight) {
      if (now - flight.since > TIMING.inflightTtlMs) this.inflight.delete(id);
    }
    const today = dayKey(now);
    if (today !== this.lastDay) {
      this.lastDay = today;
      if (pruneStats(data.stats, now)) changed = true;
    }

    const due = [];
    for (const r of data.reminders) {
      if (this.inflight.has(r.id)) continue;
      const next = Number.isFinite(runtime.next[r.id]) ? runtime.next[r.id] : null;
      let planned = next;
      if (!r.enabled) planned = null;
      else if (next === null) planned = computeNext(r, now);
      else if (next <= now && this.isStale(r, next, now)) planned = computeNext(r, now);

      if (planned !== next || runtime.next[r.id] === undefined) {
        runtime.next[r.id] = planned;
        changed = true;
      } else if (planned !== null && planned <= now) {
        due.push(r);
      }
    }

    let fired = null;
    if (due.length && !this.blockedBy(now)) {
      // Coalesced: whatever piled up while blocked fires once, most overdue first, one visit at a time.
      due.sort((a, b) => runtime.next[a.id] - runtime.next[b.id]);
      fired = due[0];
      this.inflight.set(fired.id, { since: now, manual: false });
    }
    if (changed) this.onChange('tick');
    if (fired) this.onFire(fired, { manual: false });
    return fired ? fired.id : null;
  }

  /** A due reminder that should be skipped instead of shown late. */
  isStale(r, next, now) {
    if (r.schedule.mode === 'times') return now - next > TIMING.timesStaleMs;
    if (isActiveAt(r, now)) return false;
    return !(now - next <= TIMING.windowGraceMs && isActiveAt(r, next));
  }

  /** Why nothing may fire right now (null = free to fire). */
  blockedBy(now = this.now()) {
    const { settings, runtime } = this.getData();
    if (runtime.pausedUntil !== null && runtime.pausedUntil > now) return 'paused';
    const env = this.env() || {};
    if (env.locked) return 'locked';
    if (settings.idleAware && env.idleSec >= TIMING.idleBlockSec) return 'idle';
    if (env.busy || this.inflight.size) return 'busy';
    if (env.lastRunEndedAt && now - env.lastRunEndedAt < TIMING.runGapMs) return 'cooldown';
    return null;
  }

  /** Marks a reminder as on its way to the screen (summon / tray / demo runs are `manual`). */
  begin(id, { manual = true } = {}) {
    this.inflight.set(id, { since: this.now(), manual });
  }

  isInflight(id) {
    return this.inflight.has(id);
  }

  /** Applies a run outcome: stats, later-streak and the next fire time. Returns false for unknown reminders. */
  resolve(id, outcome) {
    const flight = this.inflight.get(id);
    this.inflight.delete(id);
    const data = this.getData();
    const r = data.reminders.find((x) => x.id === id);
    if (!r || !OUTCOMES.includes(outcome)) return false;

    const now = this.now();
    const { runtime } = data;
    const prev = Number.isFinite(runtime.next[id]) ? runtime.next[id] : null;
    // A manual run (summon/tray) pre-empts the upcoming regular slot rather than replacing the schedule.
    const upcoming = flight && flight.manual && prev !== null && prev > now ? prev : null;
    let next;

    switch (outcome) {
      case 'yes': {
        this.count(id, 'yes', now);
        delete runtime.laterStreak[id];
        // "Already did it" before today's fixed slot → that slot is done too.
        const consumes = r.schedule.mode === 'times' && upcoming !== null && dayKey(upcoming) === dayKey(now);
        next = computeNext(r, consumes ? upcoming : now);
        break;
      }
      case 'later':
      case 'timeout':
        runtime.laterStreak[id] = Math.min(this.streakFor(id, now) + 1, 999);
        this.count(id, outcome === 'later' ? 'later' : 'missed', now);
        next = snoozeNext(r, now);
        break;
      case 'dismiss':
        next = upcoming !== null ? upcoming : computeNext(r, now);
        break;
      default: // 'abort': the user never saw/answered it
        next = upcoming !== null ? upcoming : delayedNext(r, now, TIMING.retryMs);
    }

    runtime.next[id] = r.enabled ? next : null;
    pruneStats(data.stats, now);
    this.onChange('outcome');
    return true;
  }

  count(id, field, now) {
    const { stats } = this.getData();
    const days = (stats[id] ||= {});
    const rec = (days[dayKey(now)] ||= { yes: 0, later: 0, missed: 0 });
    rec[field] = Math.min(rec[field] + 1, 1e6);
  }

  /** Today's YES count. */
  countToday(id, now = this.now()) {
    const rec = this.getData().stats[id]?.[dayKey(now)];
    return rec ? rec.yes : 0;
  }

  /** Consecutive later/ignored answers; a new day starts with a clean slate. */
  streakFor(id, now = this.now()) {
    const data = this.getData();
    const n = data.runtime.laterStreak[id] || 0;
    if (!n) return 0;
    const rec = data.stats[id]?.[dayKey(now)];
    return rec && rec.later + rec.missed > 0 ? n : 0;
  }

  /** Re-plans after an edit when the schedule or enabled flag changed. */
  reminderSaved(prev, reminder) {
    const reschedule = !prev || prev.enabled !== reminder.enabled || !sameSchedule(prev.schedule, reminder.schedule);
    if (!reschedule) return false;
    this.getData().runtime.next[reminder.id] = reminder.enabled ? computeNext(reminder, this.now()) : null;
    this.onChange('reminder');
    return true;
  }

  /** Forgets runtime state of a deleted reminder (its stats are kept). */
  reminderRemoved(id) {
    const { runtime } = this.getData();
    delete runtime.next[id];
    delete runtime.laterStreak[id];
    this.inflight.delete(id);
    this.onChange('reminder');
  }

  /** null resumes; a future timestamp pauses (capped at 7 days). Invalid input leaves the pause unchanged. */
  setPause(until) {
    const { runtime } = this.getData();
    const now = this.now();
    if (until === null) runtime.pausedUntil = null;
    else if (typeof until === 'number' && Number.isFinite(until)) {
      runtime.pausedUntil = until > now ? Math.round(Math.min(until, now + TIMING.maxPauseMs)) : null;
    } else return runtime.pausedUntil;
    this.onChange('pause');
    return runtime.pausedUntil;
  }

  isPaused(now = this.now()) {
    const p = this.getData().runtime.pausedUntil;
    return p !== null && p > now;
  }

  /** The enabled reminder that would fire soonest (what the summon hotkey shows). */
  soonest() {
    const { reminders, runtime } = this.getData();
    let best = null;
    for (const r of reminders) {
      if (!r.enabled || this.inflight.has(r.id)) continue;
      const key = Number.isFinite(runtime.next[r.id]) ? runtime.next[r.id] : Infinity;
      if (!best || key < best.key) best = { r, key };
    }
    return best ? best.r : null;
  }
}

module.exports = {
  TIMING,
  OUTCOMES,
  parseHM,
  startOfDay,
  addDays,
  dayStart,
  atMinutes,
  startOfTomorrow,
  dayKey,
  isActiveAt,
  computeNext,
  snoozeNext,
  sameSchedule,
  pruneStats,
  Scheduler,
};
