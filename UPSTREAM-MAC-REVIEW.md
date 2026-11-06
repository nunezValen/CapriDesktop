# Upstream v1.0.1–v1.0.4 review and macOS revision 13

Base: upstream v1.0.4, commit 3215171. The full upstream history from v1.0.0 through v1.0.4 is merged with the existing Apple Silicon port. Version is now **1.0.4-mac.13**: upstream 1.0.4 plus Mac revision 13, replacing the earlier personal 1.0.12 label.

| Release | Upstream changes reviewed | Mac treatment |
| --- | --- | --- |
| 1.0.1 | Speech/CUDA recovery, language memory, microphone picker, voice/glitch volume and mute, longer replies, smaller hit area, monitor selection, boredom toggle, installation storage | Speech remains CPU/int8; no silent model downloads. Hey Capri stays on the default Mac microphone; other input supports the picker. Combined the click-through handlers to avoid competing state changes. Monitor controls and sound controls retained. Boredom is opt-in/off by default on Mac. Python/FFmpeg system installation stays manual. |
| 1.0.2 | Windows updater startup/restart and patch-note acknowledgement fixes | Windows fixes retained. Mac continues to open the release page for manual installation and never runs a Windows installer. |
| 1.0.3 | Installed-app discovery and remembered user-picked paths; Linux .deb/tar updates, dependency/update hang fixes | Added Mac bundle discovery in Applications/System Applications/user Applications, native launching and remembered .app selections. Mac protocol lookup uses Electron instead of xdg-mime. Linux update paths stay Linux-only. |
| 1.0.4 | Ten-language fixed commands, cancel queue, hold-still/version requests, configurable hotkeys, game-mode opacity, model storage selection and moving installed requirements, hidden Windows console processes | Kept the complete fixed-command tables. Mac defaults remain Cmd–Option–V/L/C; global plain arrow defaults stay on Windows/Linux. Hold/release interoperates with Mac pinned positions. Mac Whisper paths follow storage selection; move planning includes its speech cache. Failed environment rebuild retains the original files. Windows process changes retained behind platform routing. |

## New native Mac commands

- Time/date/day: uses the Mac clock, no model required.
- Battery: “battery status”, “what is my battery level?”
- Disk: “how much storage do I have?”
- OS: “what macOS version am I on?”, “show system info”.
- System sound: “what is the volume?”, “set volume to 35 percent”, “volume up/down”, “mute/unmute the speakers”. Changes are bounded and verified. Some external audio devices require hardware controls.
- Finder: “open my Downloads/Documents/Desktop/Home folder”.
- Settings: “open sound/display/Wi-Fi/Bluetooth/battery/keyboard/mouse/trackpad/accessibility/privacy settings”. These open settings; they do not change Wi-Fi, privacy grants or other protected preferences.
- App aliases: Explorer → Finder; Task Manager → Activity Monitor; Control Panel → System Settings; Notepad → TextEdit; calc → Calculator. Named browsers retain URLs/searches.

Native system phrases are currently English; upstream's existing fixed-command translations remain available in its ten languages. Arbitrary system shell commands from chat, destructive/power actions and shell-command voice macros are not added. The coding project's existing terminal remains available.

Mac startup now adds installed Homebrew/Python locations to PATH for Finder/login launches, with bootstrap running before services read their settings. Cloud keys, provider selection, speech cache and user data are retained. The in-place updater now copies all packaged scripts and patch notes, including the updated persona file.

## Validation and boundaries

- 47 focused tests; TypeScript checks; Python syntax; native helper build; production arm64 build/package and signature verification.
- Packaged read-only system checks: battery, disk, macOS version, clock and volume. No screenshot or cloud request in that check.
- Offline synthetic speech test using the previously downloaded base model in the backup. The fresh active profile has no speech model: choose Install Whisper in Mac settings to install the desired model there. No model was silently restored/downloaded.
- Migration tests verify dry-run planning/path selection and leave source data intact. A real external-disk migration and its interruption/rollback are not claimed tested.
- No real user's screen uploaded for validation. Existing opt-in cloud comment behavior is retained; Mac proactive game/idle monologues remain disabled. Boredom actions only run if the user explicitly enables that separate option.
- Physical multi-monitor/Retina, all microphone hardware/failure cases, all ten spoken languages, Windows/Linux runtime and public Gatekeeper/notarization behavior remain unverified.

## Sources

- [Full upstream comparison](https://github.com/nunezValen/CapriDesktop/compare/v1.0.0...v1.0.4)
- [Latest verified upstream release: v1.0.4](https://github.com/nunezValen/CapriDesktop/releases/tag/v1.0.4)
- [AppleScript system sound commands](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_cmds.html)

On Mac, storage moves leave a standalone/shared Ollama library in place. Only model folders already managed under Capri’s selected storage root are eligible to move; a running standalone server must be quit first. Speech caches and Capri’s Python environment can be relocated independently.

Natural system requests also expose a dedicated mac_system tool with bounded parameters; ordinary facts and coding examples do not receive it. The observed “set vol to 70 percent” read-only reply was a routing problem: abbreviated/punctuated volume commands now resolve locally, and cloud capability context describes the real Mac controls.
