# Nudgi branding

The approved identity combines the blue winking buddy from concept 02 with the waving hand from concept 01.
The canonical scalable artwork is `assets/nudgi-mark.svg`. The app icon uses a white buddy on a blue tile;
the notification-area icon uses the blue buddy on transparency. Pausing changes the buddy to grey.

Run `npm run icons` to regenerate the PNGs and the ten native-size ICO frames using Chromium's SVG renderer.
The Python entry point remains a compatibility wrapper for the same generator.

User-visible names in the title bar, tray, window titles, settings, development pages, desktop shortcuts,
installer and portable build now use **Nudgi**. The package's Windows app ID stays `com.vrajpatel.nudgebuddy`
so Windows can identify the existing installation. The profile remains `%APPDATA%\Nudge Buddy` so the rename
retains reminders, statistics, custom avatars and preferences. `NUDGE_USER_DATA` still overrides this path
for isolated testing.

The original concept preview is kept locally and excluded from release packages.
The runtime mark is a vector reconstruction of that design, with flat colour for small-icon legibility.
