# Security policy

## Supported versions

Security fixes are released for the latest version of Nudgi. Please update to the
[latest release](https://github.com/vraj-p8/nudgi/releases/latest) before reporting.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through
[GitHub security advisories](https://github.com/vraj-p8/nudgi/security/advisories/new) with steps to reproduce,
the affected version and the impact you observed. You can expect an acknowledgement within a few days.

## Scope

Nudgi runs locally and has no server or account. Relevant areas include:

- the preload bridge (`src/preload/preload.js`) and IPC input validation in the main process,
- importing avatar models and images,
- the transparent overlay window (focus, click-through) and global shortcut handling,
- packaged builds and their checksums.
