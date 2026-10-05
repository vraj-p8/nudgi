// General section: name, sound/voice, behavior, summon shortcut recorder, pause and stats reset.
import { sfx } from '../shared/sound.js';
import { $, h, debounce, glen, confirmButton, pausedText, toast } from './ui.js';

const MOD_LABEL = { commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', option: 'Alt', altgr: 'AltGr', shift: 'Shift', super: 'Win', meta: 'Win', command: 'Win', cmd: 'Win' };
const CODE_KEYS = {
  Space: 'Space', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[',
  BracketRight: ']', Backslash: '\\', Backquote: '`', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
function keyFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(code)) && Number(m[1]) <= 24) return `F${m[1]}`;
  if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
  return CODE_KEYS[code] || null;
}
const capLabel = (part) => MOD_LABEL[part.toLowerCase()] || (part.length === 1 ? part.toUpperCase() : part);

function setError(field, msg) {
  field.classList.toggle('invalid', !!msg);
  $('.err', field).textContent = msg;
  $('input', field).setAttribute('aria-invalid', String(!!msg));
}

/** A text/number input that validates live, saves debounced when valid and reverts to the saved value on blur. */
function validatedInput(input, app, key, check, parse = (v) => v) {
  const field = input.closest('.field');
  const send = debounce((v) => app.update({ [key]: v }), 400);
  input.addEventListener('input', () => {
    const msg = check(input.value);
    setError(field, msg);
    if (msg) send.cancel();
    else send(parse(input.value));
  });
  input.addEventListener('blur', () => {
    if (send.pending()) return send.flush();
    if (field.classList.contains('invalid')) {
      setError(field, '');
      input.value = app.state.settings[key];
      input.dispatchEvent(new Event('reverted'));
    }
  });
  return (value) => {
    if (document.activeElement !== input) input.value = value;
  };
}

export function mountGeneral(root, app) {
  app.bind(root);

  // ---- name ----
  const nameInput = $('#g-name', root);
  const nameHint = $('#g-name-hint', root);
  const paintHint = () => (nameHint.textContent = nameInput.value.trim() || '…');
  const syncName = validatedInput(nameInput, app, 'userName', (v) => {
    const n = glen(v);
    return !n ? 'Tell your buddy what to call you' : n > 24 ? 'Keep it to 24 characters' : '';
  }, (v) => v.trim());
  nameInput.addEventListener('input', paintHint);
  nameInput.addEventListener('reverted', paintHint);

  // ---- auto-dismiss ----
  const syncDismiss = validatedInput($('#g-dismiss', root), app, 'autoDismissSec', (v) => {
    const n = Number(v);
    return v.trim() && Number.isInteger(n) && n >= 15 && n <= 600 ? '' : 'Choose between 15 and 600 seconds';
  }, Number);

  // ---- sound ----
  const volume = $('#g-volume', root);
  const testSound = $('#g-test-sound', root);
  testSound.addEventListener('click', () => {
    sfx.volume = Number(volume.value);
    sfx.play('chime');
  });

  // ---- summon shortcut recorder ----
  const hk = $('#g-hotkey', root);
  const hkSub = $('#g-hotkey-sub', root);
  let recording = false;
  function paintHotkey(parts) {
    const accel = app.state.settings.hotkey;
    const caps = parts || (accel ? accel.split('+').map(capLabel) : []);
    hk.dataset.recording = String(recording);
    hk.replaceChildren(...(caps.length
      ? caps.map((c) => h('kbd', { text: c }))
      : [h('span', { class: 'hk-empty', text: recording ? 'Press keys…' : 'Not set' })]));
  }
  function hint(msg, warn = false) {
    const st = app.state;
    if (!msg && st.settings.hotkey && st.meta?.hotkeyActive === false) {
      msg = 'Another app already uses this shortcut. Try a different one.';
      warn = true;
    }
    hkSub.textContent = msg || 'Calls your buddy over right now.';
    hkSub.classList.toggle('warn', warn);
  }
  const stop = () => {
    recording = false;
    paintHotkey();
    hint();
  };
  hk.addEventListener('click', () => {
    if (recording) return stop();
    recording = true;
    paintHotkey([]);
    hint('Press a shortcut, or Esc to cancel.');
  });
  hk.addEventListener('blur', () => recording && stop());
  hk.addEventListener('keydown', (e) => {
    if (!recording) return;
    const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (e.key === 'Tab' && !mods.length) return;
    e.preventDefault();
    if (e.key === 'Escape') return stop();
    const key = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key) ? null : keyFromCode(e.code);
    if (!key) return paintHotkey(mods.map(capLabel));
    if (!/^F\d+$/.test(key) && !mods.some((m) => m !== 'Shift')) {
      paintHotkey([...mods, key].map(capLabel));
      return hint('Add Ctrl, Alt or Win so it can’t clash with typing.', true);
    }
    recording = false;
    app.update({ hotkey: [...mods, key].join('+') }).then(stop);
  });
  $('#g-hotkey-clear', root).addEventListener('click', () => app.update({ hotkey: '' }));

  // ---- pause ----
  const pauseSub = $('#g-pause-sub', root);
  const resumeChip = $('[data-pause="resume"]', root);
  $('#g-pause', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-pause]');
    if (!b) return;
    const v = b.dataset.pause;
    const now = new Date();
    const until = v === 'resume' ? null
      : v === 'tomorrow' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
        : Date.now() + Number(v) * 60000;
    app.call('setPause', until);
  });
  function paintPause() {
    const p = app.state.runtime.pausedUntil;
    const paused = !!p && p > Date.now();
    const text = paused ? `Paused until ${pausedText(p)}.` : 'Reminders are running.';
    if (pauseSub.textContent !== text) pauseSub.textContent = text;
    resumeChip.hidden = !paused;
  }

  // ---- reset ----
  confirmButton($('#g-reset', root), 'Click again to reset', async () => {
    if (await app.call('resetStats')) toast('Stats cleared');
  });

  app.onState((st) => {
    const s = st.settings;
    syncName(s.userName);
    paintHint();
    syncDismiss(s.autoDismissSec);
    volume.disabled = testSound.disabled = !s.sound;
    $('#g-volume-row', root).classList.toggle('disabled', !s.sound);
    if (!recording) {
      paintHotkey();
      hint();
    }
    paintPause();
  });

  return { tick: paintPause };
}
