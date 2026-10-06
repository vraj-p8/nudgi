# Changelog

All notable changes to Nudgi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [1.2.2] - 2026-10-06

### Fixed
- From the second reminder after the app started, clicking YES, Remind me later or × did nothing and the reminder
  timed out. The overlay disabled Chromium's background throttling, which left its input window hidden after the
  overlay was shown again, so Windows sent clicks to a window that discarded them.
- Hovering the bubble could switch the overlay back to click-through for a moment, so a quick click could land on the
  window underneath. The buddy also no longer loses track of the cursor after every move.

### Added
- `scripts/verify-click.cjs`, an end-to-end check that hovers and clicks the bubble with real mouse input across
  consecutive reminders.

## [1.2.1] - 2026-10-05

### Changed
- README rewritten with install, usage, development and architecture sections, badges and a fresh screenshot of
  3D Kai in settings.
- Added CHANGELOG, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY and issue / pull request templates.
- Documentation, in-app text and comments use plain hyphens instead of em and en dashes.
- Docs describe 3D Kai as the default and the SVG rig as the fallback.

## [1.2.0] - 2026-10-05

### Added
- 3D Kai, built and rigged in Blender (`scripts/build-kai.py`), animated by the same procedural engine as
  imported avatars: profile walk, turn to face you, drink, cheer and umbrella throw.
- Automatic fallback to the 2D Kai rig when WebGL or the model is unavailable.
- The buddy colour setting tints 3D Kai's hoodie.

### Changed
- The 3D engine reads per-model height and anchors from glTF extras and caches one template per model.
- Sneakers rebuilt with laces, swooshes, toe spring and a sock.

## [1.1.2] - 2026-10-05

### Fixed
- An imported 3D avatar introduced itself as "Me"; it now says "your 3D twin".
- Past the daily goal the meter clamped to the goal (8 / 8) and replayed the celebration; it now shows the
  true count (9 / 8) with full pips.

### Added
- `scripts/audit.cjs`, an end-to-end functional audit of the real app in an isolated profile.

## [1.1.1] - 2026-10-05

### Added
- 2D Kai has jointed legs (knee and ankle IK with heel strike and toe-off), wrist follow-through and the
  ballistic umbrella throw after the drop entrance.
- Animated README preview.

### Fixed
- The 3D celebration briefly snapped both arms into a T-pose.

## [1.1.0] - 2026-10-05

First public Windows release: editable reminders with schedules, snooze and goals, Kai, local 3D avatar import,
tray controls, summon hotkey, entrances, sounds and voice.

[1.2.2]: https://github.com/vraj-p8/nudgi/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/vraj-p8/nudgi/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/vraj-p8/nudgi/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/vraj-p8/nudgi/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/vraj-p8/nudgi/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/vraj-p8/nudgi/releases/tag/v1.1.0
