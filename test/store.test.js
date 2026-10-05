'use strict';

// Config store tests: sanitization of hostile/malformed input, corrupt-file recovery, atomic persistence.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const D = require('../src/main/defaults');
const {
  Store,
  sanitizeConfig,
  sanitizeSettingsPatch,
  sanitizeReminder,
  cleanText,
  cleanAccelerator,
  cleanHex,
} = require('../src/main/store');

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-store-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

const quietLog = { warn() {}, error() {} };

describe('cleanText', () => {
  it('trims, collapses whitespace and strips control characters', () => {
    assert.equal(cleanText('  Drink\n\twater\u0000 now  ', 40), 'Drink water now');
    assert.equal(cleanText('\u202Eevil', 40), 'evil');
  });

  it('truncates by user-perceived characters without splitting emoji', () => {
    assert.equal(cleanText('👨‍👩‍👧‍👦👍🏽ab', 2), '👨‍👩‍👧‍👦👍🏽');
    assert.equal(cleanText('x'.repeat(10_000_000), 40).length, 40);
  });

  it('rejects non-strings and empties unless allowed', () => {
    assert.equal(cleanText(42, 10), undefined);
    assert.equal(cleanText({ toString: () => 'x' }, 10), undefined);
    assert.equal(cleanText('   ', 10), undefined);
    assert.equal(cleanText('   ', 10, { allowEmpty: true }), '');
  });
});

describe('cleanAccelerator / cleanHex', () => {
  it('accepts real accelerators and the empty "no hotkey"', () => {
    for (const ok of ['CommandOrControl+Alt+B', 'Ctrl+Shift+Space', 'Alt+F4', 'F9', 'Super+Plus', 'Ctrl+=', '']) {
      assert.equal(cleanAccelerator(ok), ok, ok);
    }
  });

  it('rejects junk and system-wide typing hijacks', () => {
    for (const bad of ['B', 'Shift+B', 'Ctrl+', 'Ctrl+Alt', 'Ctrl+Ctrl+B', 'Hyper+B', 'Ctrl+Alt+BB', 'Ctrl++', 42, null]) {
      assert.equal(cleanAccelerator(bad), undefined, String(bad));
    }
  });

  it('normalises colours', () => {
    assert.equal(cleanHex('#ABC'), '#aabbcc');
    assert.equal(cleanHex(' #12B5D0 '), '#12b5d0');
    assert.equal(cleanHex('red'), undefined);
    assert.equal(cleanHex('#12345'), undefined);
  });
});

describe('sanitizeReminder', () => {
  const water = () => D.makeReminder('water', 'water');

  it('round-trips a valid reminder unchanged', () => {
    assert.deepEqual(sanitizeReminder(water()), water());
  });

  it('requires a safe id', () => {
    for (const id of [undefined, '', 'a b', '../x', '__proto__', 'x'.repeat(65), 7]) {
      assert.equal(sanitizeReminder({ ...water(), id }), null, String(id));
    }
    assert.ok(sanitizeReminder({ ...water(), id: '3f2b8c1e-9d4a-4c55-8a3e-0f1b2c3d4e5f' }));
  });

  it('clamps numbers, validates enums and falls back field by field', () => {
    const r = sanitizeReminder({
      ...water(),
      title: '',
      prop: 'rocket',
      action: 'dance',
      snooze: 99999,
      goal: -4,
      enabled: 'yes',
      avatarId: 'stranger',
      schedule: { mode: 'weekly', every: '0', times: 'nope', from: '25:00', to: '9:5', days: [] },
    });
    assert.equal(r.title, 'Drink water');
    assert.equal(r.prop, 'bottle');
    assert.equal(r.action, 'drink');
    assert.equal(r.snooze, D.LIMITS.snoozeMax);
    assert.equal(r.goal, 0);
    assert.equal(r.enabled, true);
    assert.equal(r.avatarId, null);
    assert.deepEqual(r.schedule, { ...water().schedule, every: D.LIMITS.everyMin });
  });

  it('normalises times and days', () => {
    const r = sanitizeReminder({
      ...water(),
      schedule: { mode: 'times', every: 45, times: ['16:00', '9:30', '09:30', '24:00', 'x'], from: '9:00', to: '22:00', days: [6, 1, 1, 7, -1, 2.5, '3'] },
    });
    assert.deepEqual(r.schedule.times, ['09:30', '16:00']);
    assert.deepEqual(r.schedule.days, [1, 6]);
    assert.equal(r.schedule.from, '09:00');
    const many = sanitizeReminder({ ...water(), schedule: { ...water().schedule, times: Array.from({ length: 40 }, (_, i) => `${String(i % 24).padStart(2, '0')}:${i < 24 ? '00' : '30'}`) } });
    assert.equal(many.schedule.times.length, D.LIMITS.maxTimes);
  });

  it('keeps the previous good value when an edit is invalid, and allows an empty greeting', () => {
    const prev = { ...water(), title: 'Hydrate!', snooze: 25 };
    const r = sanitizeReminder({ ...prev, title: 123, snooze: 'abc', greeting: '' }, prev);
    assert.equal(r.title, 'Hydrate!');
    assert.equal(r.snooze, 25);
    assert.equal(r.greeting, '');
  });

  it('drops unknown keys and truncates oversized strings', () => {
    const r = sanitizeReminder({ ...water(), question: 'q'.repeat(500), evil: '<script>', __proto__: { polluted: true } });
    assert.equal(r.question.length, D.LIMITS.question);
    assert.equal('evil' in r, false);
    assert.equal({}.polluted, undefined);
  });
});

describe('sanitizeConfig', () => {
  it('accepts the 3D buddy globally and per reminder while retaining a saved 2D selection', () => {
    const c = sanitizeConfig({ settings: { avatarId: 'me3d' }, reminders: [{ ...D.makeReminder('water', 'water'), avatarId: 'me3d' }] });
    assert.equal(c.settings.avatarId, 'me3d');
    assert.equal(c.reminders[0].avatarId, 'me3d');
    assert.equal(sanitizeConfig({ settings: { avatarId: 'nova' } }).settings.avatarId, 'nova');
  });
  it('fills a missing config with defaults', () => {
    const c = sanitizeConfig({});
    assert.deepEqual(c.settings, { ...D.DEFAULT_SETTINGS });
    assert.deepEqual(c.reminders.map((r) => r.id), ['water']);
    assert.deepEqual(c.runtime, { pausedUntil: null, next: { water: null }, laterStreak: {}, onboarded: false });
  });

  it('repairs a malformed config', () => {
    const c = sanitizeConfig({
      version: 99,
      extra: true,
      settings: { size: 'xxl', volume: 7, autoDismissSec: 2, avatarColor: 'blue', avatarId: 'custom', customAvatar: { url: 'https://evil.example/x.png' }, sound: 'loud', hotkey: 'A' },
      reminders: [{ id: 'water' }, { id: 'water', title: 'dup' }, 'junk', { id: 'bad id' }],
      stats: { water: { '2026-13-01': { yes: 1 }, '2026-10-05': { yes: '3', later: -2 } }, 'bad id': {} },
      runtime: { pausedUntil: 'tomorrow', next: { water: 'soon', ghost: 5 }, laterStreak: { water: 4.6 }, onboarded: 'yes' },
    }, { now: () => new Date(2026, 9, 5, 12).getTime(), avatarsDir: os.tmpdir() });
    assert.equal(c.version, 1);
    assert.equal('extra' in c, false);
    assert.equal(c.settings.size, 'm');
    assert.equal(c.settings.volume, 1);
    assert.equal(c.settings.autoDismissSec, D.LIMITS.autoDismissMin);
    assert.equal(c.settings.avatarColor, null);
    assert.equal(c.settings.customAvatar, null);
    assert.equal(c.settings.avatarId, D.DEFAULT_SETTINGS.avatarId, 'custom without an image falls back');
    assert.equal(c.settings.sound, true);
    assert.equal(c.settings.hotkey, D.DEFAULT_SETTINGS.hotkey);
    assert.deepEqual(c.reminders.map((r) => r.id), ['water']);
    assert.equal(c.reminders[0].title, 'Drink water');
    assert.deepEqual(c.stats, { water: { '2026-10-05': { yes: 3, later: 0, missed: 0 } } });
    assert.deepEqual(c.runtime, { pausedUntil: null, next: { water: null }, laterStreak: { water: 5 }, onboarded: false });
  });

  it('keeps a legitimate custom avatar inside userData/avatars only', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'avatars'));
    const img = path.join(dir, 'avatars', 'custom-1.png');
    fs.writeFileSync(img, 'png');
    const ctx = { avatarsDir: path.join(dir, 'avatars') };
    const ok = sanitizeConfig({ settings: { avatarId: 'custom', customAvatar: { url: pathToFileURL(img).href, name: 'me.png' } } }, ctx);
    assert.equal(ok.settings.avatarId, 'custom');
    assert.equal(ok.settings.customAvatar.name, 'me.png');
    const outside = path.join(dir, 'elsewhere.png');
    fs.writeFileSync(outside, 'png');
    const bad = sanitizeConfig({ settings: { avatarId: 'custom', customAvatar: { url: pathToFileURL(outside).href } } }, ctx);
    assert.equal(bad.settings.customAvatar, null);
    const traversal = sanitizeConfig({ settings: { customAvatar: { url: pathToFileURL(path.join(dir, 'avatars', '..', 'elsewhere.png')).href } } }, ctx);
    assert.equal(traversal.settings.customAvatar, null);
  });

  it('caps the number of reminders', () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ ...D.makeReminder('custom', `r${i}`) }));
    assert.equal(sanitizeConfig({ reminders: list }).reminders.length, D.LIMITS.maxReminders);
  });
});

describe('sanitizeSettingsPatch', () => {
  it('accepts only known, valid fields', () => {
    const patch = sanitizeSettingsPatch({ userName: '  Vraj  ', size: 'l', volume: 0.333, sound: 'no', bogus: 1, customAvatar: { url: 'file:///C:/Windows/x.png' } }, D.DEFAULT_SETTINGS);
    assert.deepEqual(patch, { userName: 'Vraj', size: 'l', volume: 0.33 });
  });

  it('only allows the custom avatar once an image exists', () => {
    assert.deepEqual(sanitizeSettingsPatch({ avatarId: 'custom' }, { customAvatar: null }), {});
    assert.deepEqual(sanitizeSettingsPatch({ avatarId: 'custom' }, { customAvatar: { url: 'file:///x' } }), { avatarId: 'custom' });
  });

  it('survives hostile payloads', () => {
    for (const p of [null, 'x', 42, [], Object.create(null)]) assert.deepEqual(sanitizeSettingsPatch(p, D.DEFAULT_SETTINGS), {});
  });
});

describe('Store persistence', () => {
  let dir;
  beforeEach(() => {
    dir = tmpDir();
  });

  it('starts from defaults on first run and writes atomically', () => {
    const s = new Store({ dir, log: quietLog });
    s.load();
    assert.equal(s.firstRun, true);
    s.flush();
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(written.reminders.map((r) => r.id), ['water']);
    assert.equal(fs.existsSync(path.join(dir, 'config.json.tmp')), false);
  });

  it('backs up a corrupt file and starts fresh', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ "settings": { oops');
    const s = new Store({ dir, log: quietLog, now: () => 1234 });
    s.load();
    assert.equal(s.data.reminders[0].id, 'water');
    assert.equal(fs.readFileSync(path.join(dir, 'config.corrupt-1234.json'), 'utf8'), '{ "settings": { oops');
  });

  it('treats a non-object root as corrupt', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '[1,2,3]');
    const s = new Store({ dir, log: quietLog, now: () => 99 });
    s.load();
    assert.ok(fs.existsSync(path.join(dir, 'config.corrupt-99.json')));
  });

  it('recovers from an interrupted write via the tmp file', () => {
    const cfg = D.defaultConfig();
    cfg.settings.userName = 'Tmp';
    fs.writeFileSync(path.join(dir, 'config.json.tmp'), JSON.stringify(cfg));
    const s = new Store({ dir, log: quietLog });
    s.load();
    assert.equal(s.data.settings.userName, 'Tmp');
    assert.equal(s.firstRun, false);
  });

  it('accepts a BOM-prefixed file and round-trips mutations', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), `\uFEFF${JSON.stringify(D.defaultConfig())}`);
    const s = new Store({ dir, log: quietLog });
    s.load();
    assert.deepEqual(s.updateSettings({ size: 'l', side: 'up' }), ['size']);
    const { prev, reminder } = s.saveReminder({ ...D.makeReminder('stretch', 'stretch-1'), title: '  Stretch!  ' });
    assert.equal(prev, null);
    assert.equal(reminder.title, 'Stretch!');
    s.flush();
    const again = new Store({ dir, log: quietLog });
    again.load();
    assert.equal(again.data.settings.size, 'l');
    assert.deepEqual(again.data.reminders.map((r) => r.id), ['water', 'stretch-1']);
    assert.equal(again.deleteReminder('stretch-1').id, 'stretch-1');
    assert.equal(again.deleteReminder({ id: 'water' }), null);
  });

  it('rejects unusable reminder payloads and enforces the limit', () => {
    const s = new Store({ dir, log: quietLog });
    s.load();
    assert.throws(() => s.saveReminder(null), /Invalid reminder/);
    assert.throws(() => s.saveReminder({ id: '../../etc' }), /Invalid reminder/);
    for (let i = s.data.reminders.length; i < D.LIMITS.maxReminders; i++) s.saveReminder(D.makeReminder('custom', `r${i}`));
    assert.throws(() => s.saveReminder(D.makeReminder('custom', 'one-too-many')), /up to 30/);
    assert.doesNotThrow(() => s.saveReminder({ ...D.makeReminder('custom', 'r5'), title: 'edit ok' }));
  });
});
