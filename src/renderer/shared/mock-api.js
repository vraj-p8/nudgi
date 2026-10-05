// Browser-only stand-in for the Electron preload bridge (window.nudge).
// Lets overlay/settings pages run in a normal browser via `npm run dev:web`
// (http://localhost:5178/renderer/...). Inside Electron window.nudge already exists and this is a no-op.
//
// Dev helpers (browser console / automation):
//   __nudgeMock.run({ templateKey: 'water', ...overrides })  -> pushes an overlay run
//   __nudgeMock.log                                            -> calls made by the page
//   __nudgeMock.state()                                        -> current mock state
// Overlay URL params: ?demo=<templateKey>  auto-runs that template once the overlay is ready.
//                     &kind=welcome        sends a welcome run instead.
//                     &streak=N            sets vars.laterStreak; &count=N sets vars.count.
//                     &entrance=walk|drop|peek  &avatar=<id>  &style=comic|bubble  &size=s|m|l  &side=left|right

if (!window.nudge) {
  const templates = await fetch(new URL('../../main/templates.json', import.meta.url)).then((r) => r.json());
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fromTemplate = (key, id) => {
    const { key: k, ...rest } = clone(templates.find((t) => t.key === key) || templates.find((t) => t.key === 'custom'));
    return { id: id || k, enabled: true, avatarId: null, ...rest };
  };
  const params = new URLSearchParams(location.search);
  const today = new Date();
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const stats = { water: {}, call: {} };
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    stats.water[dayKey(d)] = { yes: [5, 7, 8, 4, 6, 8, 3][i], later: [2, 1, 0, 3, 1, 0, 2][i], missed: i % 3 === 0 ? 1 : 0 };
    if (i % 2 === 0) stats.call[dayKey(d)] = { yes: 1, later: i === 2 ? 1 : 0, missed: 0 };
  }

  const reminders = [fromTemplate('water', 'water'), { ...fromTemplate('call', 'call'), enabled: false }];
  let state = {
    settings: {
      userName: 'friend',
      avatarId: params.get('avatar') || 'nova',
      avatarColor: null,
      customAvatar: null,
      size: params.get('size') || 'm',
      side: params.get('side') || 'right',
      bubbleStyle: params.get('style') || 'comic',
      entrance: params.get('entrance') || 'random',
      hotkey: 'CommandOrControl+Alt+B',
      sound: true,
      volume: 0.6,
      voice: false,
      autoDismissSec: 90,
      idleAware: true,
      launchAtLogin: true,
    },
    reminders,
    templates: clone(templates),
    stats,
    runtime: {
      pausedUntil: null,
      next: { water: Date.now() + 23 * 60000, call: null },
      laterStreak: { water: 0 },
      onboarded: true,
    },
    meta: { version: '1.0.0-dev', isPackaged: false, platform: 'browser' },
  };

  const listeners = { state: new Set(), run: new Set() };
  const log = [];
  const emitState = () => listeners.state.forEach((cb) => cb(clone(state)));
  const record = (name, ...args) => {
    log.push({ name, args, at: Date.now() });
    console.debug('[nudge-mock]', name, ...args);
  };
  const ok = async (mutate) => {
    if (mutate) mutate();
    emitState();
    return clone(state);
  };

  let seq = 0;
  const makeRun = (over = {}) => {
    const { templateKey, reminder: r0, ...rest } = over;
    const reminder = r0 || (templateKey ? fromTemplate(templateKey) : state.reminders[0]);
    const s = state.settings;
    const kind = rest.kind || 'reminder';
    const welcome = {
      ...fromTemplate('water', 'welcome'),
      greeting: "Hi {name}! I'm {buddy} 👋",
      question: "I'll remind you to drink water every 45 min.",
      yesLabel: 'Sounds good',
      laterLabel: 'Customize',
      yesReply: "Let's go! 💧",
      laterReply: 'Opening settings…',
      action: 'cheer',
    };
    return {
      runId: `mock-${++seq}`,
      kind,
      preview: true,
      reminder: kind === 'welcome' ? welcome : reminder,
      avatar: { id: reminder.avatarId || s.avatarId, color: s.avatarColor, customUrl: s.customAvatar ? s.customAvatar.url : null },
      settings: {
        size: s.size, side: s.side, bubbleStyle: s.bubbleStyle, entrance: s.entrance,
        sound: s.sound, volume: s.volume, voice: s.voice, autoDismissSec: s.autoDismissSec,
      },
      vars: {
        name: s.userName,
        snooze: reminder.snooze,
        count: Number(params.get('count') ?? 3),
        goal: reminder.goal || 0,
        title: reminder.title,
        laterStreak: Number(params.get('streak') ?? 0),
      },
      display: { width: innerWidth, height: innerHeight },
      ...rest,
    };
  };

  window.nudge = {
    getState: async () => clone(state),
    onState: (cb) => (listeners.state.add(cb), () => listeners.state.delete(cb)),
    updateSettings: (patch) => (record('updateSettings', patch), ok(() => (state.settings = { ...state.settings, ...patch }))),
    saveReminder: (rem) =>
      (record('saveReminder', rem),
      ok(() => {
        const i = state.reminders.findIndex((r) => r.id === rem.id);
        if (i >= 0) state.reminders[i] = clone(rem);
        else state.reminders.push(clone(rem));
        state.runtime.next[rem.id] = rem.enabled ? Date.now() + (rem.schedule.every || 60) * 60000 : null;
      })),
    deleteReminder: (id) => (record('deleteReminder', id), ok(() => (state.reminders = state.reminders.filter((r) => r.id !== id)))),
    testReminder: async (rem) => {
      record('testReminder', rem);
      setTimeout(() => listeners.run.forEach((cb) => cb(makeRun({ reminder: clone(rem) }))), 50);
    },
    pickAvatarImage: async () => {
      record('pickAvatarImage');
      return null;
    },
    clearAvatarImage: () => (record('clearAvatarImage'), ok(() => (state.settings.customAvatar = null))),
    setPause: (untilMs) => (record('setPause', untilMs), ok(() => (state.runtime.pausedUntil = untilMs))),
    resetStats: () => (record('resetStats'), ok(() => (state.stats = {}))),
    openSettings: () => record('openSettings'),

    onRun: (cb) => (listeners.run.add(cb), () => listeners.run.delete(cb)),
    overlayReady: () => {
      record('overlayReady');
      const demo = params.get('demo');
      const kind = params.get('kind');
      if (demo || kind) setTimeout(() => window.__nudgeMock.run({ templateKey: demo || 'water', ...(kind ? { kind } : {}) }), 300);
    },
    respond: (runId, outcome) => record('respond', runId, outcome),
    runDone: (runId) => record('runDone', runId),
    setInteractive: (v) => record('setInteractive', v),
  };

  window.__nudgeMock = {
    log,
    state: () => clone(state),
    run: (over) => {
      const run = makeRun(over);
      listeners.run.forEach((cb) => cb(run));
      return run;
    },
  };
}
