// Live preview stage for the reminder editor: the real avatar + the real speech bubble, fed by the draft.
import { createAvatar } from '../shared/avatar-engine.js';
import { createBubble } from '../shared/bubble.js';
import { sfx } from '../shared/sound.js';
import { fill } from '../shared/text.js';
import { h, debounce, wait, spokenBuddyName, dayKey } from './ui.js';

const HEIGHT = 210;

export function createPreview(stageEl, app, getDraft) {
  const stage = h('div', { class: 'stage-floor' });
  stageEl.append(stage);
  const avatarOf = (d, s) => {
    const id = d.avatarId || s.avatarId || 'nova';
    return id === 'custom'
      ? s.customAvatar ? { id, url: s.customAvatar.url } : { id: 'nova', url: null }
      : id === 'me3d' ? app.state.meta.avatarModelUrl ? { id, url: app.state.meta.avatarModelUrl } : { id: 'nova', url: null } : { id, url: null };
  };

  let seq = 0;
  let mode = 'ask';
  let s = app.state.settings;
  let d = getDraft();
  let who = avatarOf(d, s);
  let prop = `${d.prop}|${d.emoji}`;

  const av = createAvatar(stage, { avatarId: who.id, customUrl: who.url, height: HEIGHT, prop: d.prop, emoji: d.emoji });
  av.setColor(s.avatarColor);
  const bubble = createBubble(stage, { style: s.bubbleStyle, accent: s.avatarColor, sound: true });

  const vars = () => ({
    name: app.state.settings.userName,
    snooze: Number.isFinite(d.snooze) ? d.snooze : undefined,
    count: app.state.stats[d.id]?.[dayKey()]?.yes || 0,
    goal: Number.isFinite(d.goal) ? d.goal : 0,
    title: d.title,
    buddy: spokenBuddyName(who.id),
  });
  const ask = () => {
    const v = vars();
    return { greeting: fill(d.greeting, v), question: fill(d.question, v), yesLabel: fill(d.yesLabel, v), laterLabel: fill(d.laterLabel, v) };
  };

  function place() {
    const w = stage.clientWidth;
    if (!w) return;
    av.x = Math.round(Math.min(w - av.width - 12, Math.max(12, w * 0.6 - av.width / 2)));
    const { x, y } = av.anchor('top');
    bubble.placeAbove(x, y, { width: w, height: stage.clientHeight });
  }
  const ro = new ResizeObserver(() => requestAnimationFrame(place));
  ro.observe(stage);

  async function showAsk({ instant = false } = {}) {
    const my = ++seq;
    mode = 'ask';
    av.setMood('neutral');
    av.pose('present');
    place();
    await bubble.show({ ...ask(), closable: false, instant, onTalk: (ms) => my === seq && av.say(ms) });
  }

  async function answer(outcome) {
    const my = ++seq;
    mode = outcome;
    const v = vars();
    if (outcome === 'yes') {
      av.setMood('happy');
      sfx.play('happy');
      const goal = v.goal > 0
        ? { count: Math.min(v.goal, v.count + 1), total: v.goal, shape: d.prop === 'bottle' || d.prop === 'glass' ? 'drop' : 'dot' }
        : null;
      await Promise.all([bubble.reply(fill(d.yesReply, { ...v, count: v.count + 1 }), { mood: 'happy', goal }), av.play(d.action)]);
    } else {
      av.setMood('sad');
      av.pose('sad');
      sfx.play('sad');
      await Promise.all([bubble.reply(fill(d.laterReply, v), { mood: 'sad' }), av.play('sigh')]);
    }
    if (my !== seq) return;
    await wait(1800);
    if (my === seq) showAsk();
  }
  bubble.onAnswer((o) => (o === 'yes' || o === 'later') && answer(o));

  const onMove = (e) => av.lookAt(e.clientX, e.clientY);
  document.addEventListener('pointermove', onMove, { passive: true });

  const refresh = debounce(() => {
    if (mode === 'ask') showAsk({ instant: true });
  }, 220);

  /** Re-reads the draft + settings and updates only what changed. */
  function update() {
    d = getDraft();
    s = app.state.settings;
    const nextWho = avatarOf(d, s);
    if (nextWho.id !== who.id || nextWho.url !== who.url) {
      who = nextWho;
      av.setAvatar(who.id, who.url);
      requestAnimationFrame(place);
    }
    const nextProp = `${d.prop}|${d.emoji}`;
    if (nextProp !== prop) {
      prop = nextProp;
      av.setProp(d.prop, d.emoji);
    }
    av.setColor(s.avatarColor);
    bubble.setStyle(s.bubbleStyle);
    bubble.setAccent(s.avatarColor);
    refresh();
  }

  requestAnimationFrame(() => showAsk());

  return {
    update,
    replay: () => (sfx.play('chime'), showAsk()),
    yes: () => answer('yes'),
    later: () => answer('later'),
    destroy() {
      seq++;
      refresh.cancel();
      ro.disconnect();
      document.removeEventListener('pointermove', onMove);
      bubble.destroy();
      av.destroy();
      stage.remove();
    },
  };
}
