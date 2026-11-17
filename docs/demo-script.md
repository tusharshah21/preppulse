# Demo script (2.5 to 3 minutes, file mode)

Recorded in file mode: the app plays a public research video (UBFC-rPPG, subject 3) through the SmartSpectra SDK instead of a webcam, because no live participant was recorded (see the README's "Demo" section). One caption or voice-over line per shot. Target length about 2:50.

Start the app for a recording run (PowerShell, from the project folder, diagnostics off, looping on):

```powershell
Remove-Item Env:PREPPULSE_DIAGNOSTICS, Env:PREPPULSE_REPLAY -ErrorAction SilentlyContinue; $env:PREPPULSE_VIDEO = "data\videos\ubfc-rppg\subject3\vid.avi"; $env:PREPPULSE_VIDEO_LOOP = "1"; npm start
```

## Rules for the recording

- **The demo banner is in every shot.** "Demo input: public research video (UBFC-rPPG, subject 3), not a live webcam" sits at the top of the window; never crop it out or cover it. No "SIMULATED DATA" banner or "(simulated data)" label may appear anywhere (no `PREPPULSE_REPLAY`).
- **No frames of the participant.** The preview box must read "Preview not available for dataset video". If any picture of a person ever appears, stop and do not use the take.
- **Never press "Start now anyway".** Calibrate right before the test, so the test starts at once.
- **Video restarts are fine.** The video is 61 s long and loops; at each restart the app shows "Paused: video restarted" for about 12 seconds and the report shows the gap. Leave it in; it is honest.
- **Words:** describe what was measured, compared with the baseline. No stress, anxiety, panic, nervous, good/bad, better/worse, normal, or any medical claim, in captions or voice-over. Never suggest the person in the video was taking the test.
- **Progress section:** demo sessions never count towards "Your progress", so it shows "Take 3 practice tests to see your patterns." and the session appears under "Demo sessions". Show that as it is.
- **Order:** record "Delete all my data" last, after any screenshots for the README and the PDF, because it removes the session.
- Screen recording at 1080p or higher; keep the mouse slow over the report.

## Shot list

| # | Time | Shot | Caption / voice-over |
|---|------|------|----------------------|
| 1 | 0:00 to 0:20 | **Cold open: calibration.** Calibration screen mid-way with the banner at the top: pulse and breathing numbers updating, the breathing waveform moving, both calm-seconds bars filling, the preview box reading "Preview not available for dataset video". Hold long enough to see the numbers update. | Caption from the first frame: "Signals in this demo come from a public research video played through the SmartSpectra SDK's file input." Voice-over: "This is PrepPulse reading pulse and breathing with the Presage SmartSpectra SDK, on this laptop." |
| 2 | 0:20 to 0:32 | **Consent screen** (recorded at the start of the session, cut in here). Scroll the list slowly, then press "I agree, start camera". | "With a webcam, the camera only turns on after I agree. Video is processed on this computer and never saved, and the SDK's telemetry is off." |
| 3 | 0:32 to 0:40 | **Calibration done**, "Before you begin" with the saved calm baseline. | "First it learns a calm baseline. Every number later is compared with that baseline, never with anyone else." |
| 4 | 0:40 to 0:46 | Select **"4-minute quick demo"**, press "Start test". | "A quick 4-minute mock test." |
| 5 | 0:46 to 1:08 | **Test, sped up about 10x** (caption "4 minutes, sped up"). Answer, change an answer once, mark one for review, timer running. No numbers on screen. | "While the student works, there are no numbers on screen, just the test. In this demo, the person in the video isn't taking it." |
| 6 | 1:08 to 1:23 | **Mid-test reset at real speed.** "Take a 30-second reset" in the header: the circle grows and shrinks, "Breathe in" / "Breathe out", the faint breathing line behind it, the note that the timer keeps running. Cut after one breath, then "Back to the test". | "A 30-second reset, usable mid-test. The timer keeps running, and in the real exam it works with eyes on the paper." |
| 7 | 1:23 to 1:31 | **Check-in:** "How did that test feel?", pick "A bit tough". | "Afterwards, an optional check-in. The answer is kept with this test, on this computer." |
| 8 | 1:31 to 1:46 | **Your pressure map:** header (score, time, "Measured"), "You said: a bit tough", the pulse timeline with question bands, the labelled reset band, the "not measured: video restarted" gaps. | "The pressure map: how the body responded, question by question. Gaps where measurement paused, including each video restart, are shown, never filled in." |
| 9 | 1:46 to 2:01 | **Hover a question band** on the pulse chart to show its details, then **click a tile** in the question-by-question strip. | "Each question shows the pulse change compared with the calm baseline, and how much of it was measured." |
| 10 | 2:01 to 2:13 | **"What we noticed":** pan over the observations, read the first one aloud as it appears. | Read the top observation aloud as written, then: "It describes what was measured, not why. Here the readings come from the research video, so they don't reflect a response to these questions." |
| 11 | 2:13 to 2:23 | **Home:** "Demo sessions" with this session, and "Your progress" with "Take 3 practice tests to see your patterns." | "Demo sessions are kept apart and never count as anyone's progress. With real tests, PrepPulse shows a student's own patterns side by side. No scores for the body, no arrows." |
| 12 | 2:23 to 2:33 | **Support screen** from "Need to talk to someone?" on home: Tele-MANAS 14416 and 1-800-891-4416, findahelpline.com, emergency line. | "Support is always one tap away. After a test it only appears if the student says it felt really overwhelming, never because of pulse or breathing." |
| 13 | 2:33 to 2:43 | **Settings: "Delete all my data"**, confirm, home shows no baseline and no past tests. | "Everything is stored only on this computer, with no account, and it can all be deleted in one click." |
| 14 | 2:43 to 2:50 | **End card:** PrepPulse name, repository URL, "Built with the Presage SmartSpectra SDK. Not a medical device. Demo input: UBFC-rPPG subject 3 (Bobbia et al., Pattern Recognition Letters, 2017)." | (caption only) |

## Checks after recording

- Scrub the whole video once: the demo banner is visible in every shot; no picture of the participant anywhere; no "SIMULATED DATA" banner or "(simulated data)" label; no API key or a terminal showing `.env`.
- Captions match the app's wording (the report title is "Your pressure map", subtitle "How your body responded, question by question").
