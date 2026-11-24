# Phone Studio PWA — the recorder as a web page

The SAME recorder as the native iOS app, as a Progressive Web App:
open it in Safari, Add to Home Screen, no signing, no App Store, no
$99, no computer. The native app is not wasted — its design ports
directly (calibration math, pre-compensation, take flow, residual
check). The .ipa stays on GitHub for the day a computer turns up.

## What it does

- **Beat import** — pick an audio file (MP3, M4A, WAV); decoded to the
  context rate, stored in IndexedDB.
- **Bluetooth calibration** — 5 clicks through the headphones, timed
  back through the phone mic; median delay, bounds 5–600 ms, min 3 of
  5 heard. Stored per headphones under a label the user types (Safari
  exposes no Bluetooth device identity).
- **Pre-compensation** — the beat (and overdub takes) play EARLY by the
  measured delay D, so the singer hears the beat on time and the vocal
  lands on time. Trim is lead-in ONLY when pre-comp is on, lead-in +
  delay when off. See `MATH.md` for the math, checked against the
  Swift code.
- **Recording** — raw PCM via AudioWorklet, exported as 32-bit float
  WAV (same as the native app). No MediaRecorder fallback was needed.
- **Residual check** — port of `ResidualVerifier.swift`: vocal phrase
  onsets vs beat onsets, median offset, MAD ≤ 40 ms, apply only a
  late residual in (15 ms, 300 ms); never corrects an early vocal.
- **Tracks** — beat, lead, ad-libs, harmonies. Takes stored in
  IndexedDB (raw + aligned WAV + metadata JSON sidecar, same fields
  as the native `TakeMetadata`). Share via the Web Share API, or
  download.
- **Mic test** — 10 seconds with no beat, to prove which mic the phone
  used (phone mic = full range; headset mic = nothing above ~4 kHz).
- **Screen-on** — Wake Lock API during takes and calibration, plus a
  plain-words warning that recording stops if Safari backgrounds or
  the screen locks. If the page hides mid-take, the take is finished
  immediately and flagged interrupted — nothing is silently lost.

## Files

| File | What it is |
| --- | --- |
| `index.html` | App shell + UI (plain words, big buttons) |
| `styles.css` | Dark mobile-first styles |
| `app.js` | UI, take flow, calibration UI, mic test, export |
| `audio.js` | Web Audio engine: context, mic, scheduling, pre-comp |
| `worklet.js` | AudioWorklet processor: raw PCM capture |
| `calibrate.js` | Click synthesis + onset detection + median (pure) |
| `residual.js` | Residual verifier port (pure) |
| `wav.js` | Float32 WAV encode / WAV decode (pure) |
| `db.js` | IndexedDB: takes, beats, mic test |
| `store.js` | localStorage: sessions, calibrations |
| `manifest.webmanifest` | PWA manifest (relative paths) |
| `sw.js` | Service worker, cache-first app shell |
| `icon.svg`, `icon-180.png`, `icon-192.png`, `icon-512.png` | Icons (no emoji) |
| `make-icons.py` | Icon generator (stdlib only) |
| `MATH.md` | Pre-comp math, checked against the Swift code |
| `test/selftest.js` | Node self-test (27 checks) |
| `verify.py` | HTML/manifest/service-worker verification |

No build step. Plain HTML/JS/CSS, fully client-side, runs from any
static host. All paths are relative (`./`) — the site lives at a
subpath (GitHub Pages), not a domain root.

## Verification (all run on this VM, Nov 24)

- `node --check` on all 10 JS files: **pass**.
- `node test/selftest.js`: **27/27 pass**, including:
  - Calibration: injected 187 ms delay measured as 187.02 ms (all 5
    clicks within 0.00 ms of each other); 44.1 kHz, 234 ms measured
    as 234.01 ms; 2-of-5-heard fails; silence fails cleanly.
  - Residual: 120 ms late → applied, trim = median offset; on-time →
    within-tolerance; early → recorded, never corrected; too few
    onsets / disagreeing onsets → unverified; base trim applied
    before matching.
  - WAV: float32 round-trip bit-exact.
  - Pre-comp trim arithmetic: lead-in-only vs lead-in + delay, guard.
- `python3 verify.py`: **pass** — HTML parses and balances, all 29
  ids referenced in JS exist, all scripts/links resolve, manifest
  valid with relative paths, service-worker precache (16 entries)
  all resolve, no root-relative paths anywhere.
- Icons: PNGs validated (signature, dimensions, IDAT decompresses).

## Two deliberate improvements over the native app (found by testing)

1. **Onset detector (calibrate.js).** The native `findOnset`
   peak-picks a sample, then walks back to 10% of the peak. For a
   12 ms multi-cycle 2 kHz burst in real room noise, the loudest
   sample can sit anywhere inside the burst, and the walk-back stops
   at the zero-crossing just before it — the self-test measured 3–8 ms
   of error and scatter. This port works on a 1 ms block envelope
   (max absolute value per block), which has no zero-crossings: first
   block above 10% of the peak envelope, refined to the first sample
   above threshold. Same constants (10% of peak, −40 dBFS detection
   threshold), same median/bounds — only the onset finding is more
   robust. Measured error after the fix: 0.02 ms.
2. **Residual verdict strings.** The native `TakeMetadata` doc
   comment lists kebab-case verdicts ("within-tolerance") but the
   Swift enum's raw values are actually camelCase ("withinTolerance").
   This port uses the documented kebab-case contract.

## Known limitations (honest, not hidden)

- **Not tested on a real iPhone.** The VM has no iOS Safari. The real
  test is Denasse's mic test through the PWA.
- **HFP risk.** Safari cannot select the input device. If iOS routes
  the mic to the Bluetooth headset (HFP), the recording is
  low-quality (8 kHz, mono). The app carries a plain-words warning
  and the mic test proves which mic was used. No hacks are attempted
  to force the input.
- **Backgrounding stops recording.** Wake Lock + a visible warning;
  if the page hides mid-take, the take is finished and flagged
  interrupted.
- **Calibration aliasing (shared with the native app).** A delay over
  600 ms aliases into the next click's search window (identical
  clicks, 0.6 s apart) and reads as (delay − 600 ms). Real Bluetooth
  delay is 100–300 ms, far from the aliasing zone.
- **Nominal latency is an estimate.** The web has no input-latency
  API; the fallback is `outputLatency` (when reported) + 10 ms,
  floored at 20 ms. It is used only for uncalibrated/speaker takes,
  which are flagged, and the residual check measures what is left.
- **Storage.** Takes are 32-bit float WAV (~35 MB per 3-minute take
  for raw + aligned). iOS Safari storage is limited; export and
  delete old takes if space runs short.

## Hosting

Lives under `docs/` in the `phone-studio-recorder` repo, served by
GitHub Pages. The parent enables Pages (repo Settings) after the
push. URL will be
`https://336nasse-crypto.github.io/phone-studio-recorder/`.
