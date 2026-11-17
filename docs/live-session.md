# Live session checklist

One live camera session, used to retune `lib/config.js` and to fill in the network section of the README. It uses the real SDK, the API key and credits. Read the whole page once before starting.

## For the person on camera

- **Light:** even, soft light on your face from the front (a window in front of you, or a lamp behind the screen). No bright window or lamp behind you, and no flickering light.
- **Position:** sit back so your face, shoulders and upper chest are all in the camera view. If the app says "Place more of the chest in view" or "sit back so your shoulders are in view", move back or tilt the laptop screen down a little.
- **Clothing:** a plain, light-coloured top. Avoid dark tops, stripes and busy patterns.
- **One face only:** nobody else in the frame, including posters or photos behind you.
- **Keep still during calibration:** sit comfortably, face the camera, do not talk or chew gum. It takes a few minutes; the first minute or so is the camera getting ready.
- **During the test:** work through the questions for real, as you would in a mock exam. Normal small movements are fine; the report shows any pauses honestly.

## Run order

1. **Start netwatch** in its own PowerShell window, from the project folder, and leave it running:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\netwatch.ps1
   ```

2. **Start the app with diagnostics on**, in a second window (see "Starting both at once" below for one-liners):

   ```powershell
   $env:PREPPULSE_DIAGNOSTICS = "1"; npm start
   ```

3. **Consent:** read the screen, press "I agree, start camera".
4. **Calibration:** press "Start practice test" (it calibrates first when there is no baseline from today; to force a fresh one, use "Learn my calm baseline" or "Redo calibration"). Keep still until it says it is done. A fresh calibration on the day is best, so the diagnostics include its timings.
5. **Quick test:** on "Before you begin", choose the 4-minute quick demo and press "Start test". Work through the questions genuinely.
6. **One reset during the test:** about halfway through, press "Take a 30-second reset" in the test header, follow the circle for the three breaths, then "Back to the test".
7. **Check-in:** answer "How did that test feel?" honestly.
8. **Report:** wait for "Your pressure map" to fill in. Optionally "Save report as PDF".
9. **Close the app.** The camera already turned off when the report was saved, which wrote the diagnostics file.
10. **Stop netwatch:** it stops by itself about 10 seconds after the app has closed; otherwise press Ctrl+C in its window.

## Starting both at once

PowerShell (netwatch opens in its own window):

```powershell
Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File scripts\netwatch.ps1'; $env:PREPPULSE_DIAGNOSTICS = "1"; npm start
```

cmd:

```bat
start "netwatch" powershell -NoProfile -ExecutionPolicy Bypass -File scripts\netwatch.ps1 & set "PREPPULSE_DIAGNOSTICS=1" && npm start
```

Make sure `ELECTRON_RUN_AS_NODE` is not set in that window (see the README's troubleshooting section).

## What you get

Both files are in `data/diagnostics/` (gitignored):

- `<timestamp>.json`, one per camera session: seconds from camera start to the first pulse, breathing and HRV readings and to their first stable readings, spacing between pulse readings, breathing readings per minute, counts of each validation status and error code, how long calibration took and why it ended, and per-question coverage from the test. Numbers and status names only: no frames, no face data, no hints, answers or key.
- `netwatch-<timestamp>.csv`: each distinct remote address and port the app's processes connected to, with reverse-DNS name (often empty for cloud and CDN addresses), connection states, process IDs, and first and last seen. Connection metadata only, no packet contents. TCP only: DNS lookups go through the Windows DNS client and do not show here.

Afterwards: retune `lib/config.js` from the diagnostics numbers, and fill in "Network connections observed" in the README from the netwatch CSV. Done for Run 1 on 2026-11-17 (see CLAUDE.md, "Live Run 1").
