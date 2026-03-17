# Auto Ad Skipper for YouTube (AASFY)

## Probably the only YouTube ad skipper that still works.

Most ad-skipping extensions have been disabled by YouTube's recent updates. AASFY takes a fundamentally different approach — instead of blocking ads or simulating button clicks (both of which YouTube now defeats), it mutes and fast-forwards through ads at 16x speed, so each ad is over in 1–2 seconds with zero audio. YouTube sees the ad as played, so there's nothing to block.

## How it works

When an ad starts, AASFY instantly:
- Mutes the audio
- Sets playback speed to 16x (Chrome's maximum)
- Shows a dark overlay on the player so you know what's happening
- Restores your original volume and speed the moment the ad ends
- A live countdown tells you exactly how long until the ad is gone.

## What it handles

- Skippable and non-skippable in-stream ads
- Multiple consecutive ads
- Mid-roll ads in long videos
- Ads in playlists
- Full-screen mode
- Picture-in-picture mode
- Overlay / banner ads (auto-dismissed)

## Privacy & transparency

- Does not block ads — YouTube cannot detect or disable it
- Does not track you or collect any data
- No network requests made by the extension
- Session and lifetime ad counts shown in the popup (stored locally, never transmitted)
- Fully open source on GitHub — read every line yourself
- This is not an ad blocker. It does not prevent ads from loading or interfere with YouTube's revenue model. Ads play to completion, just silently and 16x faster.

Originally created to help differently-abled users who have difficulty pressing the skip button. Useful for everyone tired of waiting.

## Release history

- V2.0.0 — Complete rewrite. Replaced click-based skip strategy with mute + 16x fast-forward. Added skip overlay with live countdown, session/lifetime ad counter, dark mode popup, auto-dismiss for banner ads. Removed all code that YouTube was able to block.
- V1.1.0 — Added CSS file, updated name, description, appearance, logo, screenshot
- V1.0.0 — Initial release