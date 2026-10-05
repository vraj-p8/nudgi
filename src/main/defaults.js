'use strict';

const os = require('os');
const TEMPLATES = require('./templates.json');

const AVATAR_IDS = ['me3d', 'nova', 'custom'];
const PROP_IDS = ['bottle', 'glass', 'phone', 'mug', 'pill', 'dumbbell', 'glasses', 'book', 'emoji', 'none'];
const ACTION_IDS = ['drink', 'call', 'stretch', 'breathe', 'cheer', 'nod'];
const AVATAR_HEIGHTS = { s: 250, m: 360, l: 440 };
const ENTRANCES = ['walk', 'drop', 'peek', 'random'];

const LIMITS = {
  title: 40,
  emoji: 8,
  greeting: 60,
  question: 90,
  label: 24,
  reply: 80,
  everyMin: 1,
  everyMax: 24 * 60,
  snoozeMin: 1,
  snoozeMax: 240,
  maxTimes: 12,
  goalMax: 30,
  maxReminders: 30,
  userName: 24,
  autoDismissMin: 15,
  autoDismissMax: 600,
};

function guessFirstName() {
  try {
    const raw = os.userInfo().username || '';
    const first = raw.split(/[\s._-]+/).filter(Boolean)[0] || '';
    if (!first || /^(user|admin|administrator|owner|pc)$/i.test(first)) return 'friend';
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    return 'friend';
  }
}

const DEFAULT_SETTINGS = Object.freeze({
  userName: guessFirstName(),
  avatarId: 'nova',
  avatarColor: null,
  customAvatar: null,
  size: 'm',
  side: 'right',
  bubbleStyle: 'comic',
  entrance: 'random',
  hotkey: 'CommandOrControl+Alt+B',
  sound: true,
  volume: 0.6,
  voice: false,
  autoDismissSec: 90,
  idleAware: true,
  launchAtLogin: true,
});

function getTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

function makeReminder(templateKey, id) {
  const t = getTemplate(templateKey) || getTemplate('custom');
  const { key, ...rest } = JSON.parse(JSON.stringify(t));
  return { id: id || key, enabled: true, avatarId: null, ...rest };
}

function defaultConfig() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    reminders: [makeReminder('water', 'water')],
    stats: {},
    runtime: { pausedUntil: null, next: {}, laterStreak: {}, onboarded: false },
  };
}

module.exports = {
  TEMPLATES,
  AVATAR_IDS,
  PROP_IDS,
  ACTION_IDS,
  AVATAR_HEIGHTS,
  ENTRANCES,
  LIMITS,
  DEFAULT_SETTINGS,
  getTemplate,
  makeReminder,
  defaultConfig,
};
