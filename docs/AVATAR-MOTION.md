# Custom avatar motion

## Result

Kai (`nova`) is the bundled default and renders in 3D from `src/renderer/shared/avatars/models/kai.glb`, built by
`scripts/build-kai.py` in Blender with the same 52-bone T-pose skeleton as supported imported avatars (`me3d`).
Both use the procedural skeletal adapter. The model's height and face/chest anchors come from glTF scene extras.
If WebGL or the model is unavailable, Kai falls back to the SVG rig.
Desktop sizes are 250 / 360 / 440 px. Personal GLB models are excluded from source control and release packages.
The adapter was validated with a 52-bone Avaturn rig; see [import requirements](CUSTOM-AVATAR.md).

Kai's distance-driven gait now excludes the screen ground margin from airborne motion, blends leg amplitude
when starting/stopping, and matches foot velocity through swing transitions. Held props fade at full size.
The SVG fallback rig has knee and ankle IK (heel strike, toe-off, crouch absorption), wrist follow-through and
the same ballistic umbrella throw as the 3D adapter.

## Motion plan and research

1. Preserve contact. Drive the walking phase from distance travelled, solve the legs with two-bone IK, and use
   heel/ball pivots for heel strike and toe-off. Check stationary stance feet and floor penetration numerically.
   [Kovar, Schreiner and Gleicher, Footskate Cleanup (2002)](https://graphics.cs.wisc.edu/Papers/2002/KSG02/)
   explains the contact constraints behind this approach. This app uses a procedural gait, rather than their
   complete motion-capture editing algorithm.
2. Preserve continuity. Use closed-form critically damped springs for pose channels and cursor tracking.
   Retain the elbow bend frame near straight-arm IK configurations, and blend wrist corrections as normalized
   quaternions. The techniques follow [Daniel Holden's spring derivations](https://theorangeduck.com/page/spring-roll-call)
   and [Three.js quaternion interpolation](https://threejs.org/docs/pages/Quaternion.html).
3. Author plausible paths. Lower raised arms along an outward arc, rather than moving the hand through its
   shoulder. Limit arm/forearm/hand angular speed to 500 degrees/second. Slow the giggle's shoulder pulses,
   add anticipation before a hop, derive flight time from height and gravity, and ease through landing.
4. Validate the actual animation. Sample local joint quaternions at 60 Hz during every action, then separately
   exercise the real transparent desktop window, preload, IPC, answer reactions, exits and settings cards.

## Important implementation details

- One shared animation ticker drives the 3D instances. Waking from a timer inside a frame cannot schedule a
  second animation callback; the original behavior multiplied callbacks during hops and slowed the timeline.
- Locomotion waits for model loading. Stopped or replaced load-time walk requests settle without starting.
- The director's 10 px ground margin is positioning, not flight. Airborne blending is constrained by actual
  available altitude, so a trailing spring cannot pull the feet below the floor after landing.
- IK supplies target poses; the final arm filters prevent singularities from becoming visible twists. Hand,
  palm and bottle-spout anchors are recomputed from the rendered joints, so bubbles and contact checks match
  what is on screen.
- The 3D/2D facade keeps its public identity and event subscriptions during a buddy switch. Destroying a rig
  settles pending timelines, including detached overlapping tweens. WebGL loss or model failure recovers to Kai.
- The model and vendored Three.js files are included in the packaged application. No network service is
  needed to load or animate the avatar.

## Reproduce verification

```powershell
npm test
& .\node_modules\electron\dist\electron.exe scripts/verify-avatar.cjs
& .\node_modules\electron\dist\electron.exe scripts/verify-desktop.cjs
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python scripts/inspect-avatar-rig.py
npm run build
```

On Windows, launch the Electron verification scripts with `Start-Process -WindowStyle Hidden` and redirect stdout
and stderr if the shell returns before the GUI executable's completion. Desktop verification uses a separate
temporary configuration and disables login startup and global hotkeys in that test profile.

The verification reports contain action-specific maximum joint steps, stance-foot sliding, minimum toe height,
bottle-to-mouth distance, observed desktop frame rate, IPC outcomes and renderer errors. Screenshots cover the
studio, profile walk, drinking, sad posture, entrances and Buddy settings. Check the current reports in
`output/avatar/verification.json`, `output/avatar/blender-rig.json`, and `output/desktop/verification.json`.

Final observed checks on 2026-10-05: 99 Node tests passed; 16 actions and 10 props passed in Electron;
desktop animation ran at approximately 60 Hz; sampled flat-foot stance sliding was 0 px/frame; toe joints stayed
at least 0.015 m above the model ground during the walking sample; the drinking spout approached within 0.032 m
of the mouth. These are sampled measurements, not guarantees for every possible device or input sequence.
The NSIS and portable builds completed, their packaged model and adapter files matched the source byte for byte,
and the unpacked executable displayed the enlarged 3D buddy and reminder without renderer errors.

## Limits

Expressions use head, shoulder and body posture because this model has no facial morph targets. The walk is
procedural, with contact checks on a flat desktop ground plane; it is not motion capture or a terrain controller.
Measured frame rate depends on GPU, display scaling and desktop load. The fallback remains available if WebGL
cannot run. Imported avatar media packs remain a separate, deferred feature.


## Entrance revision - 2026-10-05

The descent profile integrates smooth velocity ramps around a steady middle section, with a short final approach.
It follows the qualitative canopy-supported descent described by [NASA Glenn's flight equations with drag](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/flight-equations-with-drag/),
without claiming to simulate a real human suspended from an umbrella. The lateral envelope and its derivative
vanish at both endpoints, so arrival does not snap back to centre. Closed-form springs continue to follow
[Daniel Holden's spring reference](https://theorangeduck.com/page/spring-roll-call).

The held canopy has additional vertical headroom. The throw expands the same renderer's horizontal frustum
before wind-up, retaining camera distance and avatar pixel scale. `scene.attach` preserves the umbrella's world
transform when it leaves the hand. Its released trajectory integrates gravity analytically for each frame and
continues angular motion until it leaves the screen. Cancellation disposes the released geometry, restores the
original canvas dimensions and settles its waiting promise.

After release, the reminder prop stays hidden through arm follow-through and a reach to the hip. The grip closes
before the prop is drawn forward to the presentation pose. Its physical size remains constant; opacity fades
replace the former overshooting scale animation. The overhead wrist pose shares pronation with the forearm,
keeping the canopy close to upright.

Walking constraints now include the swinging leg so the knee does not snap straight near touchdown. A smooth
conservative minimum blends the two leg reach limits; swing trajectories have finite endpoint derivatives and
gait weight eases into movement. Peek uses the gait for its final approach, and each ground entrance prepares
its pose and turn offscreen.

`scripts/verify-entrances.cjs` samples the rendered rig during seven real-app scenarios: all entrances, both sides,
and every size. The final report measured zero held-canopy/wind-up clipping, toe height at least 0.015 m,
umbrella side-to-side steps below 1.1 px/frame, and full-sized bottle reveal at approximately 1.04 m hand height.
All scenarios completed and restored the reminder prop. Reports, per-frame data and screenshots are in
`output/entrances/`. The existing avatar and desktop integration scripts also pass after this revision.
