# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A two-in-one personal dashboard: live environmental readings from a ThingSpeak
weather station, plus a daily migraine-symptom check-in, with analysis linking
the two. Static HTML/CSS/JS — no build process, no package manager, no tests.

`README.md` explains the reasoning behind the design; read it before changing
behaviour, because several things that look like rough edges are deliberate.

## Development Commands

```bash
python3 -m http.server 8000        # then http://localhost:8000
node tools/set-passcode.mjs "…"    # change the dashboard passcode
```

Opening `index.html` directly also works. Plain `http://` to a LAN address does
not — WebCrypto (used by the passcode gate) needs a secure context.

## Architecture

Plain scripts attached to a `window.WD` namespace, loaded in dependency order
from `index.html`. No modules, so it still runs from `file://`.

| File | Responsibility |
|------|----------------|
| `js/config.js` | Thresholds, ThingSpeak field maps, check-in schema, colour tokens. Tunables live here; nothing else hardcodes a threshold or a colour. |
| `js/util.js` | DOM helpers, local-calendar dates, formatting, statistics (`pearson`, `mean`, `stdev`), `getJSON` with a hard timeout. |
| `js/auth.js` | Passcode gate. Holds the generated salt/verifier block. |
| `js/store.js` | Check-in persistence, ThingSpeak sync, export/import. Emits change events. |
| `js/weather.js` | Station fetching (four different views of one channel) and the freshness engine. |
| `js/analysis.js` | `cohesion`, `clarity`, `leadLag`, `co2Confound`, `pressureLink`. |
| `js/charts.js` | Chart.js time series; HTML/CSS heatmap, lead-lag bars, cohesion matrix, grouped bars, sparkline. |
| `js/checkin.js` | The daily check-in UI, slot timing, backfill. |
| `js/app.js` | Unlock, fetch, render, refresh recovery, settings dialog. |
| `firmware/weather_station/` | ESP32 sketch: BME280 + SCD41 -> channel 3000045. |

### Data flow

Four views of the weather channel, each for a different job:

- `results=360` — ~3h at 30s resolution, drives the current-condition tiles and
  their sparklines
- `days=N&average=M` — the selected chart window, averaged server-side so a
  30-day view is not 30s of noise
- `days=2&average=15` — robust 3h/24h pressure change and the risk banner
- `days=60&average=1440` — one row per day, feeding the correlation panels.
  Slow, so it is fetched after the page is already usable and at most twice an
  hour.

Check-ins are local-first in `localStorage` under `wd.checkins`, keyed
`${day}|${slot}`. If sync is configured they are also queued to a private
ThingSpeak channel; see README for the field mapping and the conflict rule.
Events from the previous version of the dashboard are preserved separately under
`wd.legacyMigraineEvents` — they count as headache days but contribute no
ratings.

### Things that are deliberate

- **A closed slot stops asking.** Once a check-in window passes, the card stops
  requesting it and it moves to the backfill row. Rating "how am I on waking" at
  20:00 would fabricate data.
- **The environment section is gated on the check-in.** Anti-anchoring; there is
  an explicit escape hatch, and only a currently-*due* slot gates.
- **Analysis panels refuse to render below their data thresholds** (in
  `CFG.ANALYSIS`) and say what they are waiting for. Do not lower these to make
  a panel appear.
- **Headache *episodes*, not headache days**, drive the lead/lag epochs.
- **CO₂ (field5) surfaces are hidden until the channel reports on it.** The NDIR
  sensor is not wired yet; nothing needs changing when it is.
- **Sync credentials are never committed.** This repo is public; a read key in
  the source would make the symptom log public with it.

### Colour

Symptom severity is one ordinal blue ramp, with level 0 rendered as an empty
cell rather than a ramp step. Each environment measure keeps its own hue
everywhere it appears. Status colours mean only good→critical and always ship
with an icon and a label. Every value in `CFG.COLOR` has been through a
contrast/CVD validator against the dark surface `#1a1a19` — re-run it rather
than hand-editing a hex.

Two CSS gotchas already hit here, worth not re-introducing:

- `repeat()` will not accept a custom property as its count, so the heatmap and
  cohesion grid templates are set from JS.
- Component classes that set `display` beat the UA's `[hidden] { display: none }`,
  hence the `!important` override at the top of `style.css`.
