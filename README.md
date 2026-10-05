# Nudgi

A playful Windows desktop buddy that reminds you to drink water, stretch, call someone and take a break.
Kai walks, peeks or arrives with an umbrella, asks your reminder, and reacts to your answer.

<p align="center">
  <img src="docs/images/nudgi-preview.webp" width="540" alt="A 3D avatar walks onto the desktop holding a bottle, asks “Hey, Vraj — did you drink water?”, drinks after YES and celebrates">
</p>
<p align="center"><sub>Shown with the author's own 3D avatar, imported locally. Nudgi ships with Kai; bring your own avatar with the guide below.</sub></p>

![Nudgi Buddy settings](docs/images/buddy-guide.png)

## Install

Download **Nudgi Setup 1.1.1.exe** from [Releases](https://github.com/vraj-p8/nudgi/releases/latest).
Run the installer, then open Nudgi from the Start menu or desktop shortcut. A portable EXE is also available.
Windows builds are currently unsigned.

Closing settings keeps reminders running in the tray. Click the tray icon to reopen settings, or right-click
it and choose **Quit Nudgi** to exit. **Ctrl+Alt+B** summons your buddy. Launch at sign-in is configurable.

## Features

- Editable reminders, active hours and weekdays, snoozing and daily progress.
- Kai, a bundled animated SVG buddy, with walking, umbrella and peek entrances.
- Optional local 3D avatar import through **Buddy → Avatar guide**.
- Size, color, sound, speech, entrance and screen-side controls.
- Local storage: no Nudgi account, analytics or cloud service required.

Create an optional avatar with [Avaturn](https://avaturn.me/) and follow the [3D avatar guide](docs/CUSTOM-AVATAR.md).
Personal models are not bundled. The 3D adapter supports specific Avaturn T-pose rigs; it is not a general-purpose importer.

## Develop

Use Windows and Node.js 22 or later:

```powershell
npm ci
npm start
```

`npm run demo` previews a water reminder. `npm run dev:web` provides browser development previews on
localhost:5178. Electron provides real scheduling, native file dialogs and tray behavior.

```powershell
npm test
.\node_modules\.bin\electron.cmd scripts/verify-launch.cjs
.\node_modules\.bin\electron.cmd scripts/verify-release.cjs
.\node_modules\.bin\electron.cmd scripts/verify-desktop.cjs
npm run build
```

Verification scripts use isolated profiles under `output/`. Set `NUDGE_TEST_MODEL` to an absolute GLB path
before running `verify-release.cjs` to include local model import verification. Builds go to `dist/`.
Generated output and personal GLB files are ignored by Git and excluded from packages.

## Architecture and privacy

Electron owns the scheduler, tray and transparent overlay. Renderers use plain ES modules, SVG for Kai,
and vendored Three.js for optional 3D avatars. Procedural animation runs locally.
Settings, statistics and models live in `%APPDATA%\Nudge Buddy` (the retained profile name).
The Avaturn link opens your default browser only when selected.

Windows is the currently verified platform. Reminder timing depends on the app running and the computer
being awake; idle-awareness can defer reminders. This release has no automatic updater.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Three.js, fonts and Electron.
Bug reports and contributions are welcome through GitHub issues and pull requests.
