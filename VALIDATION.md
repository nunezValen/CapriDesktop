# macOS validation — upstream 1.0.4 / Mac revision 15

Apple Silicon personal build. See [UPSTREAM-MAC-REVIEW.md](UPSTREAM-MAC-REVIEW.md) for release-by-release integration details.

## Passing checks

- 54 regression tests covering platform/updater routing, cloud vision/provider separation, credential-safe request metadata, Spotify selection/errors, placement/crop math, voice wake gating, microphone cleanup, screen-comment consent/lock gating, Mac command bounds, hotkeys, multilingual fixed requests and speech-cache relocation planning.
- TypeScript main/preload/renderer checks; Python voice-script syntax; Swift native helper build; production Electron arm64 package and signature verification.
- Packaged read-only native queries for battery, disk space, OS version, local clock and system volume.
- Offline synthetic speech transcription with a previously downloaded Whisper base model. Missing-model state in a fresh profile returns setup instructions; no model silently downloaded.
- Prior user acceptance on this Mac: cloud chat/vision, Spotify desktop control, login startup, permissions and local voice/wake behavior. Those accepted features are preserved by the merge; this is not a claim of fresh testing every path after each change.

## Not yet fully validated

- Real external-disk relocation, low-disk/interrupted migration and rollback on physical hardware; tests use isolated dry-run paths.
- Hardware-dependent volume/mute writes (bounded/verified in tests), every external audio device/microphone and every System Settings destination.
- All ten spoken languages, physical Retina/external displays, fullscreen Spaces and keyboard combinations on different layouts.
- Spotify Web API live credentials/Premium account path, all permission revocation/regrant combinations and a clean second Mac.
- Windows/Linux runtime; passing static checks do not establish runtime equivalence.
- Intel/older macOS compatibility, Developer ID signing/notarization and public Gatekeeper acceptance.

Local validation artifacts and API keys, app-data backups, user settings, models, private signing identity and built binaries are excluded from the source repository.

On Mac, storage moves leave a standalone/shared Ollama library in place. Only model folders already managed under Capri’s selected storage root are eligible to move; a running standalone server must be quit first. Speech caches and Capri’s Python environment can be relocated independently.

## Game-mode and personality fixes (Mac revision 14)

- Removed the unconditional cloud Live Scan disable; explicit confirmation, session-only cloud state, one-minute upload limit, stop-on-close/lock/error/settings-change, and suppression of late results are covered by the scanner service test with synthetic captures and a mocked provider.
- Added foreground game recognition/context with expiry and browser false-positive checks, plus independent persisted game-comment intervals. Game-only schedules do not capture other applications in tests.
- Mac companion/scanner use Electron panel windows. Removed the Windows-only topmost keepalive on Mac; returning from main settings preserves the game overlay. The Mac companion uses a native context menu and opens full-size shared settings.
- Compact cloud chat now retains character identity, expressive look/voice rules and recent scan memory. Cloud scanner prompts request an in-character response rather than a plain image caption. Subjective personality quality requires user acceptance.
- Actual ULTRAKILL fullscreen interaction, native menu placement during a game, live provider game commentary and real Live Scan remain pending hands-on validation. Automated tests do not establish those runtime results.

Installed revision 14 verification: the existing `/Applications/Capri Desktop.app` was updated in place with an unchanged designated signing requirement. Existing top-level JSON settings hashes matched before and immediately after the update. The installed app passed all 15 isolated-profile smoke checks with no renderer errors; the screen-capture check was deliberately skipped, and the missing-dependency check noted that Python is present. The DMG checksum verified with `hdiutil`.

Visible UI checks on the installed app confirmed the native right-click menu in desktop and game mode, full-size voice settings opened from that menu, the new game interval alongside the preserved 8-minute desktop interval, and the game overlay surviving a trip through Mac settings. The app was returned to desktop mode. No real screen images were sent to a provider during these checks.

## Game commentary cadence (Mac revision 15)

The installed foreground helper reported `process: Roblox` and `/Applications/Roblox.app`, while the previous detector accepted only the Windows `RobloxPlayerBeta` name. Native Roblox is now recognized without misidentifying browser pages or Roblox Studio. Live preference inspection confirmed desktop comments at 8 minutes and game comments at 1 minute; these preferences were not changed.

Replaced the mode-switch-reset countdown with elapsed time since the last attempt. Regression tests verify that a one-minute game interval overrides the initial eight-minute desktop delay and that brief foreground changes do not indefinitely postpone commentary. Ordinary visible gameplay is now explicitly eligible for a short reaction, with privacy and no-invented-events rules retained. Live gameplay speech cadence still needs user acceptance after installing this revision.

Mac game appearance is now resolved after transient script/AI/voice states, so a pending cloud reply cannot replace the framed eyes with the full-body thinking sprite. A platform-routing regression covers thinking, speech, script looks and explicit mode exit, preserving Windows/Linux behavior. Foreground game detection does not automatically turn off manually enabled Mac game mode.

Revision 15 was installed in place and reopened. The signing requirement remained unchanged, and the existing 8-minute desktop / 1-minute game preferences were preserved. A subsequent automatic vision request returned HTTP 200 while the native foreground helper identified Roblox; this confirms a live provider cycle, not subjective acceptance of every spoken comment. The new arm64 DMG checksum verified successfully. The game-form lock is covered by the appearance regression; a full gameplay question-and-answer retest remains for the user.
