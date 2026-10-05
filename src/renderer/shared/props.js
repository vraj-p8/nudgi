// Prop artwork for the avatar's right-hand slot (`<g data-slot="prop">`).
//
// Coordinates are grip-local: (0,0) is the centre of the gripping hand, y grows downward and one unit equals one
// avatar unit (avatar viewBox is 0 0 200 300). A bottle is ~64 units tall; every prop shares that scale.
// The engine keeps the slot upright in world space and applies the per-action tilt on top, so props are drawn upright.
//
// Gradient ids use the `nbp-` prefix; the engine (and createPropIcon) namespace every id per instance.
// Vinyl-toy style like the avatars: soft gradients, specular highlights, no black outlines.
//
// Liquids: a prop with a `water` entry in PROP_META contains `<g data-part="water">` drawn in a world-aligned
// frame whose surface is y = 0 (deeper water = larger y). The engine rotates/offsets that group every frame so the
// surface stays level, sloshes with motion and drains when the buddy drinks.

export const PROPS = [
  { id: 'bottle', name: 'Water bottle' },
  { id: 'glass', name: 'Glass of water' },
  { id: 'phone', name: 'Phone' },
  { id: 'mug', name: 'Coffee mug' },
  { id: 'pill', name: 'Vitamin' },
  { id: 'dumbbell', name: 'Dumbbell' },
  { id: 'glasses', name: 'Glasses' },
  { id: 'book', name: 'Book' },
  { id: 'emoji', name: 'Reminder emoji' },
  { id: 'none', name: 'Nothing' },
];

// spout: grip-local point brought to the mouth by the drink action.
// drinkTilt: world tilt in degrees while sipping (negative = top leans toward the face for the right hand).
// water: liquid frame (centre, half extents of the inner volume, initial fill 0..1).
// grip: false hides the avatar's front fingers (prop floats / rests in the palm).
export const PROP_META = {
  bottle: { spout: [0, -45], drinkTilt: -112, water: { cx: 0, cy: -6.3, halfW: 10.4, halfH: 26, level: 0.74 } },
  glass: { spout: [0, -22], drinkTilt: -98, water: { cx: 0, cy: -3, halfW: 11.5, halfH: 18.5, level: 0.7 } },
  mug: { spout: [-3, -19], drinkTilt: -70 },
  phone: { spout: [0, -14], drinkTilt: 0 },
  pill: { spout: [0, -13], drinkTilt: 0, consumable: true },
  dumbbell: { spout: [0, -8], drinkTilt: 0 },
  glasses: { spout: [0, -14], drinkTilt: 0 },
  book: { spout: [0, -14], drinkTilt: 0 },
  emoji: { spout: [0, -16], drinkTilt: 0, grip: false },
  none: { spout: [0, 0], drinkTilt: 0, grip: false },
  umbrella: { spout: [0, 0], drinkTilt: 0 },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A 22-unit period wave used for liquid surfaces (the engine scrolls it horizontally).
const WAVE = 'M-55,0 q5.5,-1.8 11,0 t11,0 t11,0 t11,0 t11,0 t11,0 t11,0 t11,0 t11,0 t11,0';

const ART = {
  bottle: `
    <defs>
      <linearGradient id="nbp-bottle-glass" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#CFEFFF" stop-opacity="0.55"/>
        <stop offset="0.35" stop-color="#F4FBFF" stop-opacity="0.22"/>
        <stop offset="0.8" stop-color="#BFE6FF" stop-opacity="0.28"/>
        <stop offset="1" stop-color="#8FCFF5" stop-opacity="0.6"/>
      </linearGradient>
      <linearGradient id="nbp-bottle-water" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="46">
        <stop offset="0" stop-color="#8FE3FF"/>
        <stop offset="0.3" stop-color="#3EB0F7"/>
        <stop offset="1" stop-color="#1769D2"/>
      </linearGradient>
      <linearGradient id="nbp-bottle-cap" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), black 22%)"/>
        <stop offset="0.38" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), white 18%)"/>
        <stop offset="1" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), black 30%)"/>
      </linearGradient>
      <clipPath id="nbp-bottle-inner">
        <path d="M-5,-32.5 H5 V-30.5 C5,-26.5 10.4,-25.5 10.4,-19.5 V14.6 C10.4,18.3 8.4,19.9 4.8,19.9 H-4.8 C-8.4,19.9 -10.4,18.3 -10.4,14.6 V-19.5 C-10.4,-25.5 -5,-26.5 -5,-30.5 Z"/>
      </clipPath>
    </defs>
    <path d="M-6.5,-34 H6.5 V-31 C6.5,-27.5 12,-26.5 12,-20 V15 C12,19.4 9.4,21.5 5,21.5 H-5 C-9.4,21.5 -12,19.4 -12,15 V-20 C-12,-26.5 -6.5,-27.5 -6.5,-31 Z" fill="url(#nbp-bottle-glass)"/>
    <g clip-path="url(#nbp-bottle-inner)">
      <g data-part="water">
        <path d="${WAVE} V80 H-55 Z" fill="url(#nbp-bottle-water)" opacity="0.92"/>
        <path d="${WAVE}" fill="none" stroke="#E6FBFF" stroke-width="1.2" stroke-linecap="round" opacity="0.85"/>
        <circle class="nb-bubble" cx="-3.5" cy="22" r="1.3" fill="#E8FAFF" opacity="0.8"/>
        <circle class="nb-bubble nb-bubble-2" cx="4" cy="26" r="0.9" fill="#E8FAFF" opacity="0.7"/>
        <circle class="nb-bubble nb-bubble-3" cx="0.5" cy="30" r="1.1" fill="#E8FAFF" opacity="0.7"/>
      </g>
    </g>
    <path d="M-6.5,-34 H6.5 V-31 C6.5,-27.5 12,-26.5 12,-20 V15 C12,19.4 9.4,21.5 5,21.5 H-5 C-9.4,21.5 -12,19.4 -12,15 V-20 C-12,-26.5 -6.5,-27.5 -6.5,-31 Z" fill="none" stroke="#9AD3F2" stroke-opacity="0.75" stroke-width="1"/>
    <path d="M-8.6,-17 C-8.6,-21 -6.8,-23 -5.6,-23.6 V13 C-7.6,12.6 -8.6,11 -8.6,9 Z" fill="#FFFFFF" opacity="0.62"/>
    <ellipse cx="7.6" cy="-15" rx="1.1" ry="3.4" fill="#FFFFFF" opacity="0.55"/>
    <path d="M2.6,-1.2 C2.6,1.6 4.2,3.6 4.2,5.2 A1.6,1.6 0 0 1 1,5.2 C1,3.6 2.6,1.6 2.6,-1.2 Z" fill="#FFFFFF" opacity="0.85"/>
    <rect x="-7" y="-35.6" width="14" height="3.4" rx="1.4" style="fill: color-mix(in oklab, var(--nb-accent, #FF8A5B), black 34%)"/>
    <rect x="-7.6" y="-46.6" width="15.2" height="11.8" rx="3.4" fill="url(#nbp-bottle-cap)"/>
    <path d="M-4.4,-44.2 V-37.4 M-1.5,-44.6 V-37 M1.5,-44.6 V-37 M4.4,-44.2 V-37.4" stroke="#000" stroke-opacity="0.12" stroke-width="0.9" stroke-linecap="round"/>
    <rect x="-6" y="-45.6" width="9" height="2.2" rx="1.1" fill="#FFFFFF" opacity="0.38"/>
    <path d="M-3.8,-46.4 C-3.8,-52.2 3.8,-52.2 3.8,-46.4" fill="none" style="stroke: color-mix(in oklab, var(--nb-accent, #FF8A5B), black 26%)" stroke-width="2.2" stroke-linecap="round"/>`,

  glass: `
    <defs>
      <linearGradient id="nbp-glass-body" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#D6F1FF" stop-opacity="0.6"/>
        <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.18"/>
        <stop offset="1" stop-color="#A9DCF7" stop-opacity="0.55"/>
      </linearGradient>
      <linearGradient id="nbp-glass-water" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="34">
        <stop offset="0" stop-color="#9BE7FF"/>
        <stop offset="0.35" stop-color="#4DB8F8"/>
        <stop offset="1" stop-color="#2479DA"/>
      </linearGradient>
      <clipPath id="nbp-glass-inner"><path d="M-11.6,-22.5 H11.6 L9.9,12.4 H-9.9 Z"/></clipPath>
    </defs>
    <path d="M-13,-24 H13 L11,17 C10.8,19.6 9.2,21 6.8,21 H-6.8 C-9.2,21 -10.8,19.6 -11,17 Z" fill="url(#nbp-glass-body)"/>
    <g clip-path="url(#nbp-glass-inner)">
      <g data-part="water">
        <path d="${WAVE} V70 H-55 Z" fill="url(#nbp-glass-water)" opacity="0.9"/>
        <path d="${WAVE}" fill="none" stroke="#EAFBFF" stroke-width="1.2" opacity="0.85"/>
        <g transform="translate(-3.5 1.5) rotate(-12)">
          <rect x="-4.6" y="-4.6" width="9.2" height="9.2" rx="2.2" fill="#F2FCFF" opacity="0.72"/>
          <rect x="-3" y="-3.2" width="3.4" height="2" rx="1" fill="#FFFFFF" opacity="0.9"/>
        </g>
        <circle class="nb-bubble" cx="4" cy="20" r="1" fill="#EAFBFF" opacity="0.8"/>
        <circle class="nb-bubble nb-bubble-2" cx="-1" cy="24" r="0.8" fill="#EAFBFF" opacity="0.7"/>
      </g>
    </g>
    <path d="M-10.4,12.6 H10.4 L10.6,17 C10.4,19 9.2,20 7,20 H-7 C-9.2,20 -10.4,19 -10.6,17 Z" fill="#E6F7FF" opacity="0.5"/>
    <path d="M-13,-24 H13 L11,17 C10.8,19.6 9.2,21 6.8,21 H-6.8 C-9.2,21 -10.8,19.6 -11,17 Z" fill="none" stroke="#A4D8F2" stroke-opacity="0.8" stroke-width="1"/>
    <ellipse cx="0" cy="-24" rx="13" ry="1.6" fill="none" stroke="#FFFFFF" stroke-opacity="0.8" stroke-width="1"/>
    <path d="M-10,-20 L-8.6,10 L-6.6,10 L-7.6,-20 Z" fill="#FFFFFF" opacity="0.55"/>`,

  phone: `
    <defs>
      <linearGradient id="nbp-phone-body" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#3A4258"/><stop offset="0.5" stop-color="#252C3E"/><stop offset="1" stop-color="#161B28"/>
      </linearGradient>
      <linearGradient id="nbp-phone-screen" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="#7FE3FF"/><stop offset="0.55" stop-color="#6B8CFF"/><stop offset="1" stop-color="#A472FF"/>
      </linearGradient>
    </defs>
    <rect x="-11.5" y="-31" width="23" height="44" rx="5" fill="url(#nbp-phone-body)"/>
    <rect x="-9.8" y="-28.6" width="19.6" height="38.8" rx="3.4" fill="url(#nbp-phone-screen)"/>
    <rect x="-3" y="-27.6" width="6" height="1.8" rx="0.9" fill="#141926"/>
    <circle cx="0" cy="-15.5" r="4.6" fill="#FFFFFF" opacity="0.92"/>
    <circle cx="0" cy="-16.6" r="1.7" fill="#7F8CFF"/>
    <path d="M-2.8,-12.6 C-2.4,-14.4 2.4,-14.4 2.8,-12.6" fill="#7F8CFF"/>
    <rect x="-6" y="-8.4" width="12" height="1.6" rx="0.8" fill="#FFFFFF" opacity="0.7"/>
    <rect x="-4" y="-5.6" width="8" height="1.3" rx="0.65" fill="#FFFFFF" opacity="0.45"/>
    <circle cx="0" cy="3.6" r="3.6" fill="#34D399"/>
    <path d="M-1.6,2.2 C-1.6,4.4 0.4,5.6 1.8,5.4 L2,4.3 L0.9,3.8 L0.4,4.4 C-0.3,4.1 -0.7,3.6 -0.9,2.9 L-0.3,2.4 L-0.8,1.4 Z" fill="#FFFFFF"/>
    <path d="M-9.8,-28.6 L5,-28.6 L-9.8,-6 Z" fill="#FFFFFF" opacity="0.14"/>
    <rect x="-11.5" y="-31" width="23" height="44" rx="5" fill="none" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="0.8"/>`,

  mug: `
    <defs>
      <linearGradient id="nbp-mug-body" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#E7DCD2"/><stop offset="0.35" stop-color="#FFFBF6"/><stop offset="1" stop-color="#D9CCC0"/>
      </linearGradient>
      <radialGradient id="nbp-mug-coffee" cx="0.45" cy="0.4" r="0.7">
        <stop offset="0" stop-color="#8A5A3C"/><stop offset="1" stop-color="#4A2C1C"/>
      </radialGradient>
    </defs>
    <g class="nb-steam">
      <path class="nb-steam-1" d="M-5,-24 C-8,-28 -2,-31 -5,-36 C-7,-39 -4,-42 -5,-44" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" opacity="0"/>
      <path class="nb-steam-2" d="M1,-24 C-2,-28 4,-31 1,-36 C-1,-39 2,-42 1,-44" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" opacity="0"/>
      <path class="nb-steam-3" d="M7,-24 C4,-28 10,-31 7,-36 C5,-39 8,-42 7,-44" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" opacity="0"/>
    </g>
    <path d="M10,-11 C19,-11 20,5 10,5" fill="none" stroke="#DCCFC3" stroke-width="5" stroke-linecap="round"/>
    <path d="M10,-11 C17.4,-11 18.2,3.4 10,4" fill="none" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M-12.5,-19 H11.5 V10 C11.5,15.5 7.5,18 2.5,18 H-3.5 C-8.5,18 -12.5,15.5 -12.5,10 Z" fill="url(#nbp-mug-body)"/>
    <ellipse cx="-0.5" cy="-19" rx="12" ry="3.4" fill="#CDBFB2"/>
    <ellipse cx="-0.5" cy="-18.4" rx="10.4" ry="2.5" fill="url(#nbp-mug-coffee)"/>
    <ellipse cx="-2.6" cy="-18.9" rx="4" ry="0.9" fill="#C8936A" opacity="0.6"/>
    <path d="M-0.5,2.8 C-5.4,-0.6 -5.6,-6.2 -2.6,-6.6 C-1.4,-6.8 -0.6,-5.8 -0.5,-5.2 C-0.4,-5.8 0.4,-6.8 1.6,-6.6 C4.6,-6.2 4.4,-0.6 -0.5,2.8 Z" style="fill: var(--nb-accent, #FF8A5B)" opacity="0.9"/>
    <rect x="-10.2" y="-14" width="2.6" height="22" rx="1.3" fill="#FFFFFF" opacity="0.7"/>`,

  pill: `
    <defs>
      <linearGradient id="nbp-pill-a" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), white 22%)"/>
        <stop offset="1" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), black 22%)"/>
      </linearGradient>
      <linearGradient id="nbp-pill-b" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D9E1EC"/>
      </linearGradient>
    </defs>
    <g transform="translate(0 -13) rotate(-28)">
      <path d="M0,-6 H-7.5 A6,6 0 0 0 -7.5,6 H0 Z" fill="url(#nbp-pill-a)"/>
      <path d="M0,-6 H7.5 A6,6 0 0 1 7.5,6 H0 Z" fill="url(#nbp-pill-b)"/>
      <rect x="-11" y="-4.2" width="19" height="2.4" rx="1.2" fill="#FFFFFF" opacity="0.6"/>
    </g>`,

  dumbbell: `
    <defs>
      <linearGradient id="nbp-db-bar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#EEF2F7"/><stop offset="0.5" stop-color="#A9B3C2"/><stop offset="1" stop-color="#6E7889"/>
      </linearGradient>
      <linearGradient id="nbp-db-plate" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#4A5468"/><stop offset="0.45" stop-color="#2E3546"/><stop offset="1" stop-color="#1D2230"/>
      </linearGradient>
    </defs>
    <rect x="-17" y="-2.6" width="34" height="5.2" rx="2.6" fill="url(#nbp-db-bar)"/>
    <g>
      <rect x="-25" y="-12" width="9" height="24" rx="3.4" fill="url(#nbp-db-plate)"/>
      <rect x="-25" y="-12" width="9" height="24" rx="3.4" fill="none" style="stroke: var(--nb-accent, #FF8A5B)" stroke-width="1.6" opacity="0.9"/>
      <rect x="-23.4" y="-9.6" width="2.2" height="14" rx="1.1" fill="#FFFFFF" opacity="0.22"/>
      <rect x="16" y="-12" width="9" height="24" rx="3.4" fill="url(#nbp-db-plate)"/>
      <rect x="16" y="-12" width="9" height="24" rx="3.4" fill="none" style="stroke: var(--nb-accent, #FF8A5B)" stroke-width="1.6" opacity="0.9"/>
      <rect x="17.6" y="-9.6" width="2.2" height="14" rx="1.1" fill="#FFFFFF" opacity="0.22"/>
    </g>`,

  glasses: `
    <defs>
      <linearGradient id="nbp-gl-lens" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#E3F6FF" stop-opacity="0.7"/><stop offset="1" stop-color="#9FD6F5" stop-opacity="0.35"/>
      </linearGradient>
    </defs>
    <path d="M17,-17 C17,-8 9,-3 2,-1" fill="none" stroke="#4A3428" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="-9.5" cy="-18" r="8" fill="url(#nbp-gl-lens)"/>
    <circle cx="9.5" cy="-18" r="8" fill="url(#nbp-gl-lens)"/>
    <path d="M-14,-22 L-9,-14.5 M5,-22 L10,-14.5" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
    <circle cx="-9.5" cy="-18" r="8" fill="none" stroke="#3B2A20" stroke-width="2.6"/>
    <circle cx="9.5" cy="-18" r="8" fill="none" stroke="#3B2A20" stroke-width="2.6"/>
    <path d="M-2.4,-19.4 C-1,-21.4 1,-21.4 2.4,-19.4" fill="none" stroke="#3B2A20" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M-15.6,-23 C-13.6,-25.4 -10.6,-26.2 -8,-25.8" fill="none" stroke="#8C6A55" stroke-width="1" stroke-linecap="round" opacity="0.8"/>`,

  book: `
    <defs>
      <linearGradient id="nbp-book-cover" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), black 34%)"/>
        <stop offset="0.22" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), black 12%)"/>
        <stop offset="0.6" style="stop-color: color-mix(in oklab, var(--nb-accent, #FF8A5B), white 10%)"/>
        <stop offset="1" style="stop-color: var(--nb-accent, #FF8A5B)"/>
      </linearGradient>
    </defs>
    <path d="M-11,-36 H12 C13.4,-36 14,-35.2 14,-34 V8 C14,9.2 13.4,10 12,10 H-11 Z" fill="#F6EEDC"/>
    <path d="M12,-34 V8 M10.6,-34 V8" stroke="#D8CCB4" stroke-width="0.6"/>
    <rect x="-14" y="-38" width="25" height="46" rx="3" fill="url(#nbp-book-cover)"/>
    <rect x="-14" y="-38" width="5" height="46" rx="2.4" fill="#000" opacity="0.14"/>
    <rect x="-6" y="-29" width="14" height="10" rx="2" fill="#FFFFFF" opacity="0.9"/>
    <rect x="-4" y="-26.4" width="10" height="1.6" rx="0.8" style="fill: var(--nb-accent, #FF8A5B)" opacity="0.8"/>
    <rect x="-4" y="-23.4" width="6.6" height="1.4" rx="0.7" fill="#9AA6B8"/>
    <path d="M4,8 V15 L6,13.2 L8,15 V8 Z" fill="#FF5A6E"/>
    <rect x="-8.4" y="-36" width="1.6" height="42" rx="0.8" fill="#FFFFFF" opacity="0.28"/>`,

  umbrella: `
    <defs>
      <linearGradient id="nbp-umb-canopy" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color: color-mix(in oklab, var(--nb-primary, #2BB3A3), white 22%)"/>
        <stop offset="1" style="stop-color: color-mix(in oklab, var(--nb-primary, #2BB3A3), black 18%)"/>
      </linearGradient>
      <clipPath id="nbp-umb-clip">
        <path d="M-66,-104 C-62,-134 -34,-151 0,-151 C34,-151 62,-134 66,-104 Q57.75,-112 49.5,-104 Q41.25,-112 33,-104 Q24.75,-112 16.5,-104 Q8.25,-112 0,-104 Q-8.25,-112 -16.5,-104 Q-24.75,-112 -33,-104 Q-41.25,-112 -49.5,-104 Q-57.75,-112 -66,-104 Z"/>
      </clipPath>
    </defs>
    <path d="M0,-104 V2" stroke="#5B6477" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M0,-2 V7 C0,13 -9,13 -9,7" fill="none" stroke="#6E4B36" stroke-width="3.6" stroke-linecap="round"/>
    <path d="M0,-2 V6" stroke="#A47B5F" stroke-width="1.1" stroke-linecap="round" opacity="0.7"/>
    <g clip-path="url(#nbp-umb-clip)">
      <rect x="-70" y="-156" width="140" height="56" fill="url(#nbp-umb-canopy)"/>
      <path d="M0,-151 L-33,-100 L-16.5,-100 Z M0,-151 L33,-100 L16.5,-100 Z M0,-151 L-70,-100 L-66,-125 Z M0,-151 L70,-100 L66,-125 Z" fill="#FFFFFF" opacity="0.92"/>
      <path d="M-70,-122 C-40,-136 40,-136 70,-122 L70,-100 L-70,-100 Z" fill="#000" opacity="0.08"/>
      <path d="M-50,-128 C-40,-142 -20,-148 -4,-148" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" opacity="0.35"/>
    </g>
    <circle cx="0" cy="-153" r="3.2" fill="#5B6477"/>
    <circle cx="-0.9" cy="-154" r="1.1" fill="#FFFFFF" opacity="0.6"/>`,
};

/** SVG markup (no outer <svg>) for a prop in grip-local coordinates. User text (emoji) is escaped. */
export function renderProp(id, emoji) {
  if (id === 'emoji') {
    const e = esc(emoji || '⭐');
    return `<g class="nb-prop-emoji"><ellipse cx="0" cy="-2" rx="11" ry="3" fill="#000" opacity="0.08"/>` +
      `<text x="0" y="-17" font-size="34" text-anchor="middle" dominant-baseline="central" ` +
      `style="font-family: 'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif">${e}</text></g>`;
  }
  return ART[id] || '';
}

let iconSeq = 0;

/**
 * Standalone <svg> element previewing a prop (for pickers). Ids are namespaced, the emoji is set via textContent.
 * Accent colours follow `--nb-accent` / `--nb-primary` inherited from the surrounding page.
 */
export function createPropIcon(id, emoji, { size = 40 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const box = id === 'umbrella' ? '-72 -160 144 180' : '-30 -54 60 78';
  svg.setAttribute('viewBox', box);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const suffix = `__pi${++iconSeq}`;
  svg.innerHTML = namespaceIds(id === 'emoji' ? renderProp('emoji', '') : renderProp(id), suffix);
  if (id === 'emoji') svg.querySelector('text').textContent = emoji || '⭐';
  return svg;
}

/** Rewrites id="x", url(#x) and href="#x" so several copies of the same markup can coexist in one document. */
export function namespaceIds(markup, suffix) {
  return markup
    .replace(/\bid="([^"]+)"/g, (m, id) => `id="${id}${suffix}"`)
    .replace(/url\(#([^)]+)\)/g, (m, id) => `url(#${id}${suffix})`)
    .replace(/href="#([^"]+)"/g, (m, id) => `href="#${id}${suffix}"`);
}
