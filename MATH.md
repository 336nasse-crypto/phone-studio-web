# Pre-compensation math — web port, checked against the native app

Source of truth: `recorder-app/PhoneStudio/Audio/AudioEngineManager.swift`
(`beginTake` / `finishTake`), `LatencyCalibrator.swift`, `TrackRecorder.swift`,
`ResidualVerifier.swift`, and `SETUP.md` § "THE MATH" (lines ~1987–1995).

## 1. What D is

D is the **round-trip** Bluetooth delay, measured acoustically by the
calibrator: play a click, time its return through the phone mic.

    D = D_out + D_in

- D_out: output path delay — the time from the audio leaving the render
  timeline to the sound reaching the singer's ears (Bluetooth codec +
  wireless trip). Typically 100–300 ms.
- D_in: input path delay — the time from a sound reaching the phone mic
  to that sample appearing in the recording (mic + OS buffer + browser).
  Typically 5–15 ms.

The calibrator measures D directly: click scheduled at render-time C,
onset found in the recording at render-time C + D_out + D_in. The
measurement never separates D_out from D_in — and it never needs to.

Native check: `LatencyCalibrator.calibrate` — `delays.append((startSample
+ onset) - scheduled)`; the median across 5 clicks is the delay.
Bounds: 5–600 ms, minimum 3 of 5 clicks heard. Ported exactly.

## 2. The anchor

The **anchor A** is the time the singer HEARS the beat start:

    A = now + 1.2 s        (anchorDelay = 1.2 s, native constant)

1.2 s = ~0.2 s for the input tap to settle + ~1.0 s of lead-in (clean
room noise before the beat, which the pipeline measures its noise floor
from). The lead-in is MEASURED, never assumed:

    lead-in = A − F0

where F0 is the render-time of the first recorded sample (native:
`firstBufferSampleTime`; web: the first AudioWorklet block's
`currentTime`). Typical lead-in ≈ 1.0 s.

## 3. Pre-compensation (calibrated Bluetooth, D known)

The beat is scheduled EARLY by the full round-trip D:

    beat frame 0 renders at A − D

Timeline (all times on the render clock):

    A − D        beat frame 0 leaves the phone
    A − D + D_out = A − D_in
                 the beat reaches the singer's ears — D_in EARLY
                 (~5–15 ms: imperceptible, below the rhythm-perception
                 threshold)
    A − D_in + t the singer sings beat-time t (on the beat as heard)
    A − D_in + t + D_in = A + t
                 the tap captures that phrase — the D_in early-hearing
                 EXACTLY cancels the D_in capture delay

So in the recording, the vocal for beat-time t lands at **A + t** —
exactly on the anchor. Full-D early playback + lead-in-only trim is
EXACT, not approximate.

Native check: `AudioEngineManager.beginTake` —
`playbackAnchor = AVAudioTime(sampleTime: anchor.sampleTime −
delaySamples)`; guard `delaySeconds < anchorDelay − 0.1` (1.1 s) so
playback is never scheduled in the past (calibration bounds D to
0.6 s, so the guard always passes in practice).

Web port: `source.start(A − D)` on the `AudioContext` clock. Same
guard: pre-comp only if D < 1.1 s.

## 4. Trim reconciliation

The trim removes the front of the raw recording so beat-time 0 lands
at file sample 0.

- **Pre-comp ON** (calibrated Bluetooth): the vocal already lands on
  time (A + t in the recording). Trim = **lead-in ONLY**.
  Trimming D again would over-correct by the full delay.

      trim = lead-in = A − F0

- **Pre-comp OFF** (wired/speaker, or uncalibrated Bluetooth): the beat
  played at the anchor, so the singer heard it D_out late and the vocal
  lands D late in the recording. Trim = **lead-in + delay**
  (the post-shift path).

      trim = lead-in + D

  D here is the measured acoustic D when a calibration exists but
  pre-comp was off (D failed the future-margin guard — practically
  impossible), the session nominal latency for wired/speaker, or the
  nominal latency as a fallback for uncalibrated Bluetooth (the take
  is flagged uncalibrated — the nominal UNDERSTATES the real Bluetooth
  delay, and the residual check may catch part of it).

Native check: `AudioEngineManager.finishTake` —
`baseTrimSamples = preCompensationActive ? leadInSamples :
leadInSamples + delaySamples`.

## 5. Residual check

After the base trim, `ResidualVerifier` measures what is left from the
take itself (Bluetooth drift since calibration, or the unmeasured delay
on an uncalibrated take) and trims only that:

- Vocal phrase-start onsets (first 30 s) vs drum-hit onsets in the beat
  (the beat file IS the grid — no BPM assumption).
- Median offset across matched onsets; MAD (median absolute deviation)
  must be ≤ 40 ms or the check refuses.
- Apply only a positive (late) residual in (15 ms, 300 ms).
  ≤ 15 ms is imperceptible — leave it. > 300 ms is implausible — refuse.
  A negative residual (vocal early) is recorded, NEVER corrected.
- Minimum 3 matched onsets, else unverified.

Total trim = base trim + residual trim, applied once, clamped to the
file length. The raw file is never touched.

Native check: `ResidualVerifier.verify` — ported function-for-function
(see `residual.js`).

## 6. Web clock mapping (the one thing that differs from native)

Native AVAudioEngine runs input and output on ONE sample clock, so the
tap's `when.sampleTime` and the scheduled playback times are directly
comparable. The web has the same property, on a different API:

- Output schedule: `AudioContext.currentTime` (seconds) — the render
  timeline. `source.start(when)` schedules on it.
- Input timestamps: the AudioWorklet's `currentTime` for each 128-frame
  block — the SAME render timeline. The first block's `currentTime`
  is F0.

Because both are the render timeline, the calibration measurement is
identical to native: click scheduled at C, onset at C + D_out + D_in
in the recorded stream, measured D = onset − C. No wall clock anywhere.

One web-specific note: the worklet delivers samples in 128-frame blocks,
so F0 has 128-frame granularity (~2.7 ms at 48 kHz). The lead-in is
measured from F0, so the trim inherits at most ~2.7 ms of error — well
inside the 15 ms residual tolerance, and the residual check measures
what is left anyway.

## 7. What the web CANNOT do (honest limits)

- **Input selection.** Native picks the phone's built-in mic explicitly
  (`setPreferredInput`). Safari cannot select the input device. If iOS
  routes the mic to the Bluetooth headset (HFP), the recording is
  low-quality (8 kHz, mono). The app carries a plain-words warning and
  the mic test (frequency content) proves which mic was used. No hacks
  are attempted to force the input.
- **Background recording.** Native keeps recording when the screen
  locks. Safari STOPS when it backgrounds or the screen locks. The app
  uses the Wake Lock API during a take and warns plainly; if the page
  hides mid-take, the take is finished immediately (flagged
  interrupted) so nothing is silently lost.
- **Device identity.** Native stores the calibration per headphone by
  port UID. Safari exposes no Bluetooth device identity. The app stores
  the delay + a label the user types for the headphones.
