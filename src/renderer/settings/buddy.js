// Buddy section: built-in Kai and locally imported 3D avatars.
// Kept self-contained so a "Your avatars" group can later be inserted at the top of #buddy-groups.
import { createAvatar, AVATARS } from '../shared/avatar-engine.js';
import { $, $$, h, ICON, debounce, radioGroup, buddyName } from './ui.js';

const SWATCHES = [null, '#FF7A59', '#FFC53D', '#22C55E', '#A78BFA', '#F472B6', '#60A5FA', '#C9A45C', '#E6EEF8'];
const SWATCH_NAMES = { '#FF7A59': 'Coral', '#FFC53D': 'Sunny', '#22C55E': 'Mint', '#A78BFA': 'Violet', '#F472B6': 'Rose', '#60A5FA': 'Sky', '#C9A45C': 'Champagne', '#E6EEF8': 'Frost' };
const CARD_HEIGHT = 150;

export function mountBuddy(root, app) {
  const cardsEl = $('#buddy-cards', root);
  const swatchesEl = $('#buddy-swatches', root);
  const live = new Map(); // avatar id -> engine instance (only while the section is visible)
  let active = false;
  let cardsKey = null;

  app.bind(root);
  const defaultColor = () => (AVATARS.find((a) => a.id === app.state.settings.avatarId) || AVATARS[0]).colors.primary;

  // ---------- buddy cards ----------
  function card(id, { meta, extra = null }) {
    const stage = h('div', { class: 'buddy-stage' }, h('div', { class: 'stage-floor' }));
    const pick = h('button', { type: 'button', role: 'radio', class: 'buddy-pick', 'data-value': id },
      stage, h('span', { class: 'buddy-meta' }, ...meta), h('span', { class: 'buddy-check', html: ICON.check }));
    return h('div', { class: 'buddy-card', 'data-id': id }, pick, extra);
  }

  function buildCards() {
    const cardsList = AVATARS.filter((a) => a.id === 'nova' || (a.id === 'me3d' && app.state.meta.avatarModelUrl)).map((a) =>
      card(a.id, { meta: [h('b', { text: buddyName(a.id) }), h('span', { text: a.tagline })] }));
    cardsEl.replaceChildren(...cardsList);
  }

  $('#avatar-guide-toggle', root).addEventListener('click', () => {
    const guide = $('#avatar-guide', root);
    guide.hidden = !guide.hidden;
    $('#avatar-guide-toggle', root).setAttribute('aria-expanded', String(!guide.hidden));
  });
  $('#avatar-create', root).addEventListener('click', () => app.call('openAvatarGuide'));
  $('#avatar-import', root).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await app.call('pickAvatarModel'); } finally { button.disabled = false; }
  });

  radioGroup(cardsEl, (id) => {
    if (id !== app.state.settings.avatarId) app.update({ avatarId: id });
    live.get(id)?.play('wave');
  });

  function mountLive() {
    const s = app.state.settings;
    for (const stage of $$('.buddy-stage .stage-floor', cardsEl)) {
      const id = stage.closest('[data-id]').dataset.id;
      const av = createAvatar(stage, { avatarId: id, customUrl: id === 'me3d' ? app.state.meta.avatarModelUrl : null, height: CARD_HEIGHT, prop: 'bottle' });
      av.setColor(s.avatarColor);
      av.pose('idle');
      live.set(id, av);
    }
    requestAnimationFrame(centerLive);
  }
  function centerLive() {
    for (const [id, av] of live) {
      const stage = $(`[data-id="${id}"] .stage-floor`, cardsEl);
      if (stage) av.x = Math.round((stage.clientWidth - av.width) / 2);
    }
  }
  function unmountLive() {
    for (const av of live.values()) av.destroy();
    live.clear();
  }
  const onMove = (e) => live.forEach((av) => av.lookAt(e.clientX, e.clientY));

  // ---------- color ----------
  const colorInput = h('input', { type: 'color', 'aria-label': 'Custom color' });
  swatchesEl.append(
    ...SWATCHES.map((c) => h('button', {
      type: 'button', role: 'radio', class: c ? 'swatch' : 'swatch default', 'data-value': c || '',
      'aria-label': c ? SWATCH_NAMES[c] : 'Default', title: c ? SWATCH_NAMES[c] : 'Default',
    })),
    h('label', { class: 'swatch custom', title: 'Pick any color' }, colorInput));
  for (const b of $$('.swatch[data-value]', swatchesEl)) if (b.dataset.value) b.style.setProperty('--c', b.dataset.value);

  radioGroup(swatchesEl, (v) => app.update({ avatarColor: v || null }));
  const sendColor = debounce((v) => app.update({ avatarColor: v }), 200);
  colorInput.addEventListener('input', () => {
    live.forEach((av) => av.setColor(colorInput.value));
    sendColor(colorInput.value);
  });
  colorInput.addEventListener('change', () => sendColor.flush());

  function paintColor() {
    const c = app.state.settings.avatarColor;
    const preset = SWATCHES.includes(c) ? c : undefined;
    for (const b of $$('.swatch[data-value]', swatchesEl)) {
      const on = preset !== undefined && b.dataset.value === (preset || '');
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on || (preset === undefined && !b.dataset.value) ? 0 : -1;
    }
    $('.swatch.default', swatchesEl).style.setProperty('--c', defaultColor());
    const custom = $('.swatch.custom', swatchesEl);
    custom.classList.toggle('on', preset === undefined);
    if (preset === undefined) custom.style.setProperty('--c', c);
    if (document.activeElement !== colorInput) colorInput.value = c || defaultColor();
  }

  // ---------- state ----------
  function render() {
    const s = app.state.settings;
    const key = app.state.meta.avatarModelUrl || 'kai';
    if (key !== cardsKey) {
      cardsKey = key;
      unmountLive();
      buildCards();
      if (active) mountLive();
    }
    for (const b of $$('.buddy-pick', cardsEl)) {
      const on = b.dataset.value === s.avatarId;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    live.forEach((av) => av.setColor(s.avatarColor));
    paintColor();
  }
  app.onState(render);

  return {
    activate() {
      active = true;
      render();
      if (!live.size) mountLive();
      document.addEventListener('pointermove', onMove, { passive: true });
    },
    deactivate() {
      active = false;
      unmountLive();
      document.removeEventListener('pointermove', onMove);
    },
  };
}
