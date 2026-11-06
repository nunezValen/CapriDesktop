# Capri Desktop for macOS — Apple Silicon

Personal Apple Silicon build. Intel Macs, older macOS releases and notarized public distribution are not validated.

## Install and first setup

1. Open the DMG and drag Capri Desktop to Applications.
2. Launch the installed app. If macOS blocks this personal build, review it and use System Settings → Privacy & Security → Open Anyway.
3. Choose your language, name and AI provider. For a cloud provider, enter your own API key, API address and chat model. Vision has a separate image-capable model setting.
4. Press Command–comma, click the top gear or the bottom Settings button to open the shared Settings page. AI & models and Mac & Spotify are sections on the same page. AI changes use Save; Mac options retain their individual controls. Enable only the permissions needed for the features you use.
5. Voice recognition needs Python 3.11 and FFmpeg. If you use Homebrew: `brew install python@3.11 ffmpeg`. Capri does not install system packages automatically.
6. In Mac settings, select Whisper base (~150 MB, lighter) or small (~500 MB), then Install Whisper. This prepares Capri’s Python environment and downloads the selected speech model. Speech recognition runs locally on CPU. Ollama is only required for local chat/vision.

## Mac shortcuts and interactions

| Shortcut / gesture | Action |
| --- | --- |
| Command–comma | Open settings |
| Command–Option–V | Start/stop voice recording |
| Command–Option–L | Toggle Hey Capri listening |
| Command–Option–C | Toggle companion chat |
| Command–Option–S | Open scanner; scan if already open |
| Command–Option–G | Toggle companion click-through in game mode |
| Escape | Cancel an active recording |
| Command-click Capri | Open/close companion chat |
| Right-click Capri | Companion menu: Hey Capri, voice settings, developer mode, mute |
| Left-drag | Move Capri |
| Shake left/right while dragging | Trigger glitch reaction; ordinary dragging does not trigger it |

Say “Hey Capri” followed by your question in the same utterance. Each Mac wake-listening request needs her name. Default microphone input uses echo cancellation and noise suppression; speaker audio can still physically reach the microphone. Headphones help. Global plain arrow-key shortcuts from Windows are not reserved on Mac.

## Permissions and repairing access after an update

Open Command–comma → Mac settings to review status and open the relevant System Settings page.

- Microphone: voice recording and Hey Capri.
- Screen Recording / Screen & System Audio Recording: scanner and optional automatic screen comments.
- Accessibility / Device Control and Data Access: window awareness and Spotify search selection. Names vary by macOS version.
- Automation: controlling Spotify through Apple Events.

If an update leaves permission marked enabled but the feature does not work:

1. Open System Settings → Privacy & Security.
2. Remove Capri Desktop’s old entry from the affected Screen Recording or Accessibility / Device Control and Data Access list, using the minus button where available.
3. Fully quit Capri Desktop with its application menu → Quit.
4. Add the current `/Applications/Capri Desktop.app` again and enable access. Screen Recording versions without an Add button may require launching Capri and attempting a scan to recreate the entry.
5. Quit and reopen Capri once more, then refresh status in Mac settings.

If Accessibility specifically says the desktop helper needs access, follow the settings instructions to add `/Applications/Capri Desktop.app/Contents/Resources/scripts/macos/bin/capri-desktop` as well. Avoid leaving multiple old copies enabled. Chat remains usable without these optional permissions. No Terminal password or `security` command is part of normal Capri setup.

## Screen comments and Spotify

Manual vision: ask what is on screen or use Scan. Cloud vision sends the requested image to the configured provider.

Automatic comments: Mac settings → Screen comments → enter 1–120 whole minutes → Save interval. **0 means off**, the default. When enabled, screenshots of the display under your pointer are sent to cloud vision. Comments pause while locked/suspended or Capri is busy; errors disable the schedule. Responses aim to be short, friendly Cyberpunk remarks and skip private/settings screens. This is model-guided behavior, not a guarantee of private-content detection.

Live Scan: open the scanner and click **Live off**. Cloud mode asks before enabling uploads, sends changed frame contents at most once per minute, and stays off after restarting. Closing the scanner, locking/suspending the Mac, changing AI settings or a scan error stops cloud Live Scan.

Game comments: right-click Capri → **Game screen comments**, or open **Mac settings** and set its separate interval. This is off by default; enabling it uploads screenshots while a recognized game is foreground. Detection supports Steam game paths, native macOS Roblox, and ULTRAKILL, including common Wine/CrossOver process names. When window bounds are available, capture follows the game's display. Game identity adds context but does not supply live telemetry. A zero game interval leaves the ordinary screen-comment schedule unchanged.

The Mac right-click menu works in desktop and game mode and opens the same full-size settings as the main app. Hold Command or Control over the game overlay to interact. Non-activating panels reduce application focus changes, but some exclusive-fullscreen games still minimize when another window needs keyboard focus. Use voice during fullscreen play, or borderless/windowed mode for text chat. Returning from settings preserves game mode and its position. On Mac, the framed eyes remain visible while thinking/speaking and when switching to other apps; game mode stays on until you turn it off.

Spotify defaults to Desktop app: install/sign into Spotify, grant Accessibility and Automation. Search selects the closest supported track result and verifies playback. Web API mode requires your own Spotify developer client ID, PKCE sign-in, eligible account and Premium for playback. Redirect URI: `http://127.0.0.1:43829/callback`. Capri does not silently switch providers.

## Data, updates and limitations

Settings, memories, encrypted cloud credentials, voice cache and Python environment live in `~/Library/Application Support/Capri Desktop`. Replacing the app preserves this data. Removing that folder resets Capri; keep a backup first. macOS permission grants are separate.

Mac update checks open the upstream release page for manual updates. This personal Mac DMG may not be published there. The build has no Developer ID notarization; local signing identity is not included in the source.

Supported macros: apps, URLs, music/media controls, ordinary companion game mode, speech and waits. Shell-command macros, Paint drawing, ShadowPlay and League/Cyberpunk integrations are unavailable on Mac. Windows/Linux runtime behavior remains untested.

Validation: 54 focused tests, TypeScript checks, production build and installed signature verification passed. Cloud chat/vision and voice recognition were tested on this Mac. External/Retina displays and clean installation on another Mac remain unverified.

## Native Mac compatibility update (1.0.12)

Current local time/date/day questions are answered from the device clock, including its time zone, without a cloud request. Other Mac chat requests receive current clock context. Historical date questions and explicit search/actions retain their existing routing.

Explicit Chrome, Firefox, Safari, Edge, Brave and Opera requests open the named installed browser; a query opens in that browser. Missing apps return a failure. Explorer/File Explorer resolves to Finder, Task Manager to Activity Monitor, Control Panel to System Settings, Notepad to TextEdit and calc to Calculator. Apps are asked to quit normally, allowing save prompts. The coding terminal uses a Unix shell on Mac.

Validation: 54 focused tests and type checks pass. Production arm64 packaging and installed signature verification passed. Installed chat answered the current Asia/Riyadh time and launched native Calculator. Windows/Linux runtime behavior remains untested; deferred Paint, ShadowPlay and game integrations remain unsupported on Mac.

## Upstream 1.0.4 / Mac revision 13

The port now includes upstream versions 1.0.1 through 1.0.4. The installed version label is 1.0.4-mac.13. See [UPSTREAM-MAC-REVIEW.md](UPSTREAM-MAC-REVIEW.md) for the release-by-release change list and validation limits.

Voice settings now includes microphone selection, separate sound/glitch volumes, monitor selection, customizable shortcut keys and game-mode opacity. Cmd–Option–V/L/C remain the Mac defaults. Hey Capri always uses the default Mac microphone; the picker applies to other voice input. Boredom-triggered music/tabs are off by default and require a separate explicit opt-in.

Native Mac commands now include system volume/mute, battery, disk space, macOS version, common Finder folders and opening common System Settings pages. These commands do not silently change Wi-Fi/Bluetooth/privacy settings or run arbitrary system shell commands. Coding terminal commands can find installed Homebrew tools when launched from Finder/login.

The upstream requirements-storage chooser/move planner is available on Mac, including its speech cache. Review its plan before confirming. A physical external-disk move has not been tested. System Python/FFmpeg installation remains manual; model downloads remain explicit selections.

On Mac, storage moves leave a standalone/shared Ollama library in place. Only model folders already managed under Capri’s selected storage root are eligible to move; a running standalone server must be quit first. Speech caches and Capri’s Python environment can be relocated independently.
