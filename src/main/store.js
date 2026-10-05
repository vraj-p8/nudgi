'use strict';

// Persistent config (userData/config.json): load → sanitize → mutate → debounced atomic write.
// Everything that enters the config — the file on disk and every IPC payload — passes through the sanitizers
// below: unknown keys are dropped, missing keys filled, invalid values replaced, numbers clamped, strings cleaned
// and truncated. Nothing coming from a renderer is trusted.

const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const D = require('./defaults');
const { pruneStats } = require('./scheduler');

const L = D.LIMITS;
const FILE_NAME = 'config.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_STAT_IDS = 200;
const MAX_CORRUPT_BACKUPS = 5;
const SIDES = ['left', 'right'];
const BUBBLE_STYLES = ['comic', 'bubble'];
const MODES = ['interval', 'times'];
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------------------------------------------
// Field cleaners: each returns the cleaned value, or undefined when the input is unusable.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const BIDI_RE = /[‪-‮⁦-⁩]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Single-line user text: controls → space, whitespace collapsed, truncated to `max` user-perceived characters. */
function cleanText(value, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return undefined;
  const flat = value
    .slice(0, max * 16) // bound the work for oversized payloads before segmenting
    .replace(CONTROL_RE, ' ')
    .replace(BIDI_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(flat)) {
    if (n++ >= max) break;
    out += segment;
  }
  out = out.replace(LONE_SURROGATE_RE, '').trim();
  return out || allowEmpty ? out : undefined;
}

function cleanInt(value, min, max) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Finite number clamped to [min, max], rounded to 2 decimals. */
function cleanNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;
}

const cleanBool = (value) => (typeof value === 'boolean' ? value : undefined);
const oneOf = (value, list) => (typeof value === 'string' && list.includes(value) ? value : undefined);
const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) && !RESERVED_IDS.has(value);

function cleanHM(value) {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function cleanTimes(value) {
  if (!Array.isArray(value)) return [];
  const list = value.slice(0, 64).map(cleanHM).filter(Boolean);
  return [...new Set(list)].sort().slice(0, L.maxTimes);
}

function cleanDays(value) {
  if (!Array.isArray(value)) return [];
  const list = value.slice(0, 32).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(list)].sort((a, b) => a - b);
}

function cleanHex(value) {
  if (typeof value !== 'string') return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return undefined;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']);
const KEY_RE =
  /^(?:[0-9a-z]|f(?:[1-9]|1[0-9]|2[0-4])|plus|space|tab|capslock|numlock|scrolllock|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|volumeup|volumedown|volumemute|medianexttrack|mediaprevioustrack|mediastop|mediaplaypause|printscreen|num[0-9]|numdec|numadd|numsub|nummult|numdiv|[)!@#$%^&*(:;=<,_\->.?/~`{}[\]|\\"'])$/i;

/**
 * Electron accelerator for the global summon hotkey ('' = none). Needs a non-Shift modifier unless it is a function
 * key, so a bare letter can never hijack typing system-wide.
 */
function cleanAccelerator(value) {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (!s) return '';
  if (s.length > 64) return undefined;
  const parts = s.split('+');
  if (parts.some((p) => !p)) return undefined; // the '+' key itself must be spelled "Plus"
  const key = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  if (!KEY_RE.test(key) || MODIFIERS.has(key.toLowerCase())) return undefined;
  if (mods.some((m) => !MODIFIERS.has(m)) || new Set(mods).size !== mods.length) return undefined;
  const isFunctionKey = /^f\d{1,2}$/i.test(key);
  if (!isFunctionKey && !mods.some((m) => m !== 'shift')) return undefined;
  return s;
}

/** True when `file` resolves inside `dir` (case-insensitive on Windows). */
function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** customAvatar must be a file: URL to an existing image inside userData/avatars. */
function cleanCustomAvatar(value, ctx = {}) {
  if (!isObj(value) || typeof value.url !== 'string' || value.url.length > 4096 || !ctx.avatarsDir) return undefined;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'file:') return undefined;
    const file = fileURLToPath(url);
    if (!isInside(ctx.avatarsDir, file)) return undefined;
    if (ctx.checkFiles !== false && !fs.statSync(file).isFile()) return undefined;
    return { url: pathToFileURL(file).href, name: cleanText(value.name, 80) ?? path.basename(file) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

function cleanSetting(key, value, ctx) {
  switch (key) {
    case 'userName':
      return cleanText(value, L.userName, { allowEmpty: true });
    case 'avatarId':
      return oneOf(value, D.AVATAR_IDS);
    case 'avatarColor':
      return value === null ? null : cleanHex(value);
    case 'customAvatar':
      return value === null ? null : cleanCustomAvatar(value, ctx);
    case 'size':
      return oneOf(value, Object.keys(D.AVATAR_HEIGHTS));
    case 'side':
      return oneOf(value, SIDES);
    case 'bubbleStyle':
      return oneOf(value, BUBBLE_STYLES);
    case 'entrance':
      return oneOf(value, D.ENTRANCES);
    case 'hotkey':
      return cleanAccelerator(value);
    case 'volume':
      return cleanNumber(value, 0, 1);
    case 'autoDismissSec':
      return cleanInt(value, L.autoDismissMin, L.autoDismissMax);
    case 'sound':
    case 'voice':
    case 'idleAware':
    case 'launchAtLogin':
      return cleanBool(value);
    default:
      return undefined;
  }
}

function sanitizeSettings(raw, ctx = {}) {
  const src = isObj(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(D.DEFAULT_SETTINGS)) {
    const v = has(src, key) ? cleanSetting(key, src[key], ctx) : undefined;
    out[key] = v === undefined ? D.DEFAULT_SETTINGS[key] : v;
  }
  if (out.avatarId === 'custom' && !out.customAvatar) out.avatarId = D.DEFAULT_SETTINGS.avatarId;
  return out;
}

/**
 * Validated subset of a renderer settings patch. Unknown or invalid fields are ignored; customAvatar can only be set
 * by the main process (file dialog), and 'custom' is only selectable once an image exists.
 */
function sanitizeSettingsPatch(patch, current) {
  const out = {};
  if (!isObj(patch)) return out;
  for (const key of Object.keys(D.DEFAULT_SETTINGS)) {
    if (key === 'customAvatar' || !has(patch, key)) continue;
    const v = cleanSetting(key, patch[key]);
    if (v !== undefined) out[key] = v;
  }
  if (out.avatarId === 'custom' && !(current && current.customAvatar)) delete out.avatarId;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reminders

/** Template-derived fallback for a reminder id ('water' → water template, anything else → custom). */
const baseReminder = (id) => D.makeReminder(id, id);

/**
 * Cleans one reminder. Invalid fields fall back to `base` (the previously saved version, else the template), so a
 * bad edit can never corrupt a working reminder. Returns null without a valid id.
 */
function sanitizeReminder(raw, base) {
  if (!isObj(raw) || !isId(raw.id)) return null;
  const id = raw.id;
  const b = base && base.id === id ? base : baseReminder(id);
  const rs = isObj(raw.schedule) ? raw.schedule : {};
  const bs = b.schedule;
  const times = cleanTimes(rs.times);
  const days = cleanDays(rs.days);
  const text = (key, max, opts) => cleanText(raw[key], max, opts) ?? b[key];

  let avatarId = b.avatarId;
  if (raw.avatarId === null) avatarId = null;
  else if (oneOf(raw.avatarId, D.AVATAR_IDS)) avatarId = raw.avatarId;

  return {
    id,
    enabled: cleanBool(raw.enabled) ?? b.enabled,
    title: text('title', L.title),
    emoji: text('emoji', L.emoji),
    prop: oneOf(raw.prop, D.PROP_IDS) ?? b.prop,
    action: oneOf(raw.action, D.ACTION_IDS) ?? b.action,
    greeting: text('greeting', L.greeting, { allowEmpty: true }),
    question: text('question', L.question),
    yesLabel: text('yesLabel', L.label),
    laterLabel: text('laterLabel', L.label),
    yesReply: text('yesReply', L.reply),
    laterReply: text('laterReply', L.reply),
    schedule: {
      mode: oneOf(rs.mode, MODES) ?? bs.mode,
      every: cleanInt(rs.every, L.everyMin, L.everyMax) ?? bs.every,
      times: times.length ? times : [...bs.times],
      from: cleanHM(rs.from) ?? bs.from,
      to: cleanHM(rs.to) ?? bs.to,
      days: days.length ? days : [...bs.days],
    },
    snooze: cleanInt(raw.snooze, L.snoozeMin, L.snoozeMax) ?? b.snooze,
    goal: cleanInt(raw.goal, 0, L.goalMax) ?? b.goal,
    avatarId,
  };
}

function sanitizeReminders(raw) {
  if (!Array.isArray(raw)) return D.defaultConfig().reminders;
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, L.maxReminders * 4)) {
    const r = sanitizeReminder(item);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= L.maxReminders) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Stats & runtime

function sanitizeStats(raw, now = Date.now()) {
  const out = {};
  if (!isObj(raw)) return out;
  let ids = 0;
  for (const id of Object.keys(raw)) {
    if (ids >= MAX_STAT_IDS) break;
    if (!isId(id) || !isObj(raw[id])) continue;
    const days = {};
    for (const day of Object.keys(raw[id]).slice(0, 400)) {
      const rec = raw[id][day];
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day) || !isObj(rec)) continue;
      const clean = {
        yes: cleanInt(rec.yes, 0, 1e6) ?? 0,
        later: cleanInt(rec.later, 0, 1e6) ?? 0,
        missed: cleanInt(rec.missed, 0, 1e6) ?? 0,
      };
      if (clean.yes || clean.later || clean.missed) days[day] = clean;
    }
    if (Object.keys(days).length) {
      out[id] = days;
      ids++;
    }
  }
  pruneStats(out, now);
  return out;
}

function sanitizeRuntime(raw, reminderIds) {
  const src = isObj(raw) ? raw : {};
  const srcNext = isObj(src.next) ? src.next : {};
  const srcStreak = isObj(src.laterStreak) ? src.laterStreak : {};
  const next = {};
  const laterStreak = {};
  for (const id of reminderIds) {
    const n = has(srcNext, id) ? srcNext[id] : null;
    next[id] = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    const s = has(srcStreak, id) ? cleanInt(srcStreak[id], 0, 999) : undefined;
    if (s) laterStreak[id] = s;
  }
  const p = src.pausedUntil;
  return {
    pausedUntil: Number.isFinite(p) && p > 0 ? Math.round(p) : null,
    next,
    laterStreak,
    onboarded: src.onboarded === true,
  };
}

/** Full config sanitize: the deep-merge of whatever was on disk with defaultConfig(). */
function sanitizeConfig(raw, ctx = {}) {
  const src = isObj(raw) ? raw : {};
  const reminders = sanitizeReminders(has(src, 'reminders') ? src.reminders : undefined);
  return {
    version: 1,
    settings: sanitizeSettings(src.settings, ctx),
    reminders,
    stats: sanitizeStats(src.stats, ctx.now ? ctx.now() : Date.now()),
    runtime: sanitizeRuntime(src.runtime, reminders.map((r) => r.id)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Store

class Store {
  constructor({ dir, now = Date.now, debounceMs = 400, log = console } = {}) {
    if (!dir) throw new TypeError('Store needs a directory');
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.avatarsDir = path.join(dir, 'avatars');
    this.now = now;
    this.debounceMs = debounceMs;
    this.log = log;
    this.data = null;
    this.timer = null;
    this.dirty = false;
    this.firstRun = false;
  }

  get ctx() {
    return { avatarsDir: this.avatarsDir, now: this.now };
  }

  /** Reads config.json (falling back to an interrupted write's .tmp), sanitizes it and schedules a normalising write. */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = this.readJson(this.file);
    if (raw === undefined) {
      raw = this.readJson(`${this.file}.tmp`, { quiet: true }) ?? null;
      this.firstRun = raw === null;
    }
    this.data = sanitizeConfig(raw ?? D.defaultConfig(), this.ctx);
    this.save();
    return this.data;
  }

  /** Parsed object, undefined when missing, null after a corrupt file was moved aside. */
  readJson(file, { quiet = false } = {}) {
    let text;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return undefined;
      if (st.size > MAX_FILE_BYTES) throw new Error(`file is ${st.size} bytes`);
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      if (!quiet) this.quarantine(file, err);
      return quiet ? undefined : null;
    }
    try {
      const parsed = JSON.parse(text.replace(/^﻿/, ''));
      if (!isObj(parsed)) throw new Error('root is not an object');
      return parsed;
    } catch (err) {
      if (!quiet) this.quarantine(file, err);
      return quiet ? undefined : null;
    }
  }

  /** Moves an unreadable config aside as config.corrupt-<ts>.json (keeping the newest few) and starts fresh. */
  quarantine(file, err) {
    const backup = path.join(this.dir, `config.corrupt-${this.now()}.json`);
    try {
      fs.renameSync(file, backup);
      this.log.warn(`[store] unreadable config (${err.message}); backed up to ${path.basename(backup)}`);
    } catch (moveErr) {
      this.log.warn(`[store] unreadable config (${err.message}); backup failed: ${moveErr.message}`);
    }
    try {
      const old = fs
        .readdirSync(this.dir)
        .filter((f) => /^config\.corrupt-\d+\.json$/.test(f))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      for (const f of old.slice(MAX_CORRUPT_BACKUPS)) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch {
      /* best effort */
    }
  }

  /** Debounced persist. */
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  /** Writes now if anything changed: tmp file + fsync + rename, so a crash never leaves a half-written config. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.data) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmp, this.file);
      } catch {
        // Windows: a scanner may briefly hold the target open; copying over it still keeps the tmp as a fallback.
        fs.copyFileSync(tmp, this.file);
        fs.rmSync(tmp, { force: true });
      }
    } catch (err) {
      this.dirty = true;
      this.log.error(`[store] write failed: ${err.message}`);
    }
  }

  // ---- mutations (all inputs are untrusted) ----

  /** Applies a renderer settings patch; returns the keys that actually changed. */
  updateSettings(patch) {
    const clean = sanitizeSettingsPatch(patch, this.data.settings);
    const changed = Object.keys(clean).filter((k) => this.data.settings[k] !== clean[k]);
    if (!changed.length) return changed;
    for (const k of changed) this.data.settings[k] = clean[k];
    this.save();
    return changed;
  }

  setCustomAvatar(customAvatar) {
    const s = this.data.settings;
    s.customAvatar = customAvatar;
    if (customAvatar) s.avatarId = 'custom';
    else if (s.avatarId === 'custom') s.avatarId = D.DEFAULT_SETTINGS.avatarId;
    this.save();
  }

  getReminder(id) {
    return this.data.reminders.find((r) => r.id === id) || null;
  }

  /** Upserts a reminder from the renderer. Throws on an unusable payload or when the reminder limit is reached. */
  saveReminder(raw) {
    if (!isObj(raw) || !isId(raw.id)) throw new Error('Invalid reminder');
    const prev = this.getReminder(raw.id);
    if (!prev && this.data.reminders.length >= L.maxReminders) {
      throw new Error(`You can have up to ${L.maxReminders} reminders`);
    }
    const reminder = sanitizeReminder(raw, prev || undefined);
    const list = this.data.reminders;
    if (prev) list[list.indexOf(prev)] = reminder;
    else list.push(reminder);
    this.save();
    return { prev: prev ? clone(prev) : null, reminder };
  }

  deleteReminder(id) {
    if (!isId(id)) return null;
    const prev = this.getReminder(id);
    if (!prev) return null;
    this.data.reminders = this.data.reminders.filter((r) => r !== prev);
    this.save();
    return prev;
  }

  resetStats() {
    this.data.stats = {};
    this.data.runtime.laterStreak = {};
    this.save();
  }
}

module.exports = {
  Store,
  sanitizeConfig,
  sanitizeSettings,
  sanitizeSettingsPatch,
  sanitizeReminder,
  sanitizeStats,
  sanitizeRuntime,
  cleanText,
  cleanAccelerator,
  cleanHex,
  isId,
  isInside,
};
