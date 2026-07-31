# Weather & Migraine

A personal dashboard that does two jobs at once: it shows live readings from a
ThingSpeak-connected weather station, and it collects a ten-second daily symptom
check-in — then looks for the relationship between them.

Live at <https://luppa90.github.io/weather-dashboard/>.

## Why it is built this way

Counting headache days throws away most of the signal. This tracks the *cluster*
instead — sound tolerance, light tolerance, fog, neck, fatigue, each 0–3 — plus a
binary headache flag and a binary triptan flag. Three things fall out of that
which a headache diary cannot give you:

1. **Whether the five channels co-vary as a unit.** If they rise and fall
   together, that is evidence of one underlying process rather than five
   unrelated complaints.
2. **How many days are genuinely clear.** Not "headache-free" — clear, meaning
   every channel at zero. The gap between those two counts is usually large and
   goes entirely unrecorded otherwise.
3. **Whether the cluster leads or lags the headache.** Same-day correlation says
   almost nothing. If the cluster rises 24–48h *before* a headache day and stays
   elevated after it, that is a direct measurement of your own premonitory and
   postdromal windows.

Three design decisions follow from that and are load-bearing:

- **Rate at a fixed time.** Stimulant offset produces a systematic afternoon dip
  that would otherwise smear across every channel. Morning opens at 04:00 and
  closes at 12:00; evening opens at 17:00 and closes at midnight. Once a window
  closes the dashboard stops asking — a morning rating invented at 20:00 is worse
  than a missing one, so it moves to the backfill row instead.
- **Rate before looking.** The environment section stays blurred until the due
  check-in is in, because seeing a pressure crash first will bias the rating that
  is supposed to be independent evidence. There is a "show it anyway" escape.
- **Ten seconds.** Typing `2 1 0 3 1 0 0` then Enter completes a check-in without
  touching the mouse: digits set the focused row and advance to the next one.
  There is an "All clear" button for the common case.

## Running it

Static files, no build step, no dependencies to install.

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

Opening `index.html` directly works too — the passcode uses WebCrypto, which is
available on `file://` and `https://` but not on plain `http://` to a LAN address.

## Passcode

The dashboard is behind a passcode. **It is a gate, not encryption**: this is a
static page, so anyone determined enough can read the source and skip it. What it
does is stop the dashboard being readable by someone who simply lands on the URL.
Your ratings never enter this repository — they live in this browser's
localStorage, and (optionally) in your own private ThingSpeak channel.

To change it:

```bash
node tools/set-passcode.mjs "your new passphrase"
```

That rewrites the generated block in `js/auth.js` with a fresh salt and a
PBKDF2-SHA256 verifier. The passphrase itself is never written anywhere. Changing
it logs out every device, since the unlock cookie holds the old verifier.

The unlock cookie is set with a ten-year `Max-Age`, so unlocking is a once-per-
device thing.

## Cross-device sync (optional)

Check-ins are saved locally first and always work offline. To keep a phone and a
laptop in agreement — and to survive clearing browser data — point the dashboard
at a second ThingSpeak channel:

1. Create a new ThingSpeak channel with **8 fields**, and set it to **private**.
2. Open Settings (the sliders icon) and paste the Channel ID, Write API key and
   Read API key.
3. Tick "Sync check-ins to this channel".

Field mapping on that channel:

| Field | Carries |
|-------|---------|
| field1–field5 | sound, light, fog, neck, fatigue (0–3) |
| field6 | headache (0/1) |
| field7 | triptan (0/1) |
| field8 | slot (1 = morning, 2 = evening) |
| status | `v1\|d=YYYY-MM-DD\|s=slot\|u=<epoch ms>\|n=<note>` |

The logical day and slot travel in `status` rather than in `created_at`, so
timestamps stay monotonically increasing (which ThingSpeak requires) while an
edit still overwrites the right row — on read, the highest `u` per day+slot wins.
Note text can be excluded from the sync with a checkbox if you would rather it
stayed on one device.

**The keys are stored only in your browser and are never committed here.** That
is deliberate: this repo is public, so a read key in the source would make the
symptom log public with it.

Settings also has JSON and CSV export, and JSON import.

## Weather station channel

Channel `3000045`. The read key is in `js/config.js` and is inherently public in
a static client app.

| Field | Measure |
|-------|---------|
| field1 | temperature (°C) |
| field2 | humidity (%) |
| field3 | pressure (hPa) |
| field4 | altitude — collected, unused |
| field5 | CO₂ (ppm) — **reserved for the NDIR sensor** |

Every CO₂ surface in the dashboard stays hidden until field5 actually reports a
value, so nothing needs changing when the sensor goes in: publish to field5 and
the tile, the chart and the fog-confound analysis appear on their own.

CO₂ is in here for a specific reason, stated carefully because the popular
version of this claim overstates the evidence. CO₂ is a reliable, physically
grounded proxy for *is this room exchanging air* — decades of field studies tie
poor ventilation to worse cognitive outcomes and more reported symptoms. What
is much shakier is CO₂ gas *itself*, isolated from the bioeffluents/VOCs/heat
that build up alongside it, causing that effect at the 800–1600 ppm a bedroom
actually reaches. The widely-cited studies behind that stronger claim (Satish
2012, the isolated-CO₂ arm of Allen's 2016 Harvard CogFx study) report effects
their own authors called "almost defy[ing] credibility," and every chamber
study built specifically to separate pure CO₂ from co-occurring bioeffluents
found nothing across and above this range. ASHRAE's own 2025 position
document calls the evidence "inconsistent." The oft-repeated cerebral-vasodilator
mechanism is real, but only at 20,000–40,000 ppm — 15 to 50× higher than
anything this sensor will read indoors.

None of that makes the sensor pointless — a closed, air-conditioned room
accumulates CO₂ fast precisely because it accumulates *everything* fast, and
that combination is a genuine confound for the **fog** channel and only that
channel. Separating "fog at 2 with CO₂ at 1400" from "fog at 2 with CO₂ at 600"
still tells stale air apart from clean air — it just isn't proof that the CO₂
molecule is what did it.

## Station firmware

`firmware/BUILD-GUIDE.md` is the step-by-step hardware build — soldering the
sensor hub, wiring the I2C bus, staged testing, and where to place the finished
thing so the readings mean something.

`firmware/weather_station/weather_station.ino` is the ESP32 sketch that feeds
channel 3000045. Libraries: Adafruit BME280, Sensirion I2C SCD4x (>= 1.1.0),
Sensirion Core, ThingSpeak.

The SCD41 sits on the same I2C bus as the BME280 (0x62 and 0x76) and is optional
at runtime — with no CO2 sensor attached the sketch posts fields 1-4 and the
dashboard keeps every CO2 panel hidden.

Two details worth keeping:

- **The BME280's pressure is fed to the SCD41** via `setAmbientPressure()`. CO2
  is measured optically and depends on gas density, so without it the sensor
  assumes a fixed 1013 hPa and drifts with the weather — putting a
  pressure-shaped artefact straight into the CO2 series that is being correlated
  against pressure.
- **Automatic self-calibration is off** (`ENABLE_ASC`). ASC assumes the sensor
  sees ~400 ppm outdoor air for 4 uninterrupted hours weekly; a closed
  air-conditioned room does not, and when that assumption fails ASC drags the
  whole scale down — understating exactly the readings this is here to catch.
  Recalibrate manually instead: serial command `c`, in fresh air, no sooner than
  5 days after first powering the sensor. `i` prints status, `a` toggles ASC.

## Staying in sync

Browsers freeze timers in background tabs — Firefox will suspend an unfocused tab
outright — and laptops sleep. There are five independent routes back to fresh
data, and the header pill always states how old what you are looking at is:

- a self-rescheduling timer (60s visible, 5min hidden) with exponential backoff
  on failure;
- a one-second heartbeat that detects a scheduled refresh being long overdue,
  which is how a frozen or slept tab is caught;
- `visibilitychange` and `focus`, which refetch on return if the data is stale;
- `pageshow` for a bfcache restore, whose timers come back dead;
- the `online` event.

Every request has a hard timeout, so a hung socket cannot stall the chain. The
dashboard also distinguishes *our data being old* from *the station having gone
quiet* — different problems needing different reactions.

## Analysis, and what it refuses to do

Each panel stays blank until it has enough data to support a number, and says
what it is waiting for instead:

| Panel | Needs |
|-------|-------|
| Genuinely clear days | 7 rated days |
| Cluster cohesion | 14 days with all five channels rated |
| Lead/lag | 21 rated days and 5 headache episodes |
| CO₂ × fog | 10 days with both a check-in and CO₂ |
| Pressure vs cluster | 14 rated days, and ≥5 days on each side of the split |

Consecutive headache days count once, at onset, so a three-day migraine does not
contribute three overlapping epochs and smear the very curve being resolved.

## Layout

```
index.html          markup only
style.css           chrome and layout
js/config.js        thresholds, field maps, check-in schema, colour tokens
js/util.js          DOM, local-calendar dates, formatting, statistics
js/auth.js          passcode gate
js/store.js         check-in storage, ThingSpeak sync, export/import
js/weather.js       station data and the freshness engine
js/analysis.js      cohesion, clarity, lead/lag, CO₂ confound, pressure link
js/charts.js        Chart.js time series, plus HTML heatmap / bars / matrix
js/checkin.js       the daily check-in UI
js/app.js           unlock, fetch, render, refresh recovery
tools/set-passcode.mjs
```

Plain scripts on a `window.WD` namespace, in dependency order — no bundler, and
it still works from `file://`.

Chart colours are not hand-picked. Symptom severity is one ordinal blue ramp
(level 0 is not a step — a clear day is an empty cell); each environment measure
keeps its own hue everywhere it appears; status colours mean only good→critical
and always ship with an icon and a label. The exact steps and the validator runs
behind them are documented in `js/config.js`.

---

Personal tracking aid, not medical advice.
