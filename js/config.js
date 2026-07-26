/* Configuration, design tokens and domain constants.
 *
 * Everything a future-me might want to tune lives here. The rest of the app
 * reads from WD.CFG and never hardcodes a threshold or a colour.
 */
window.WD = window.WD || {};

WD.CFG = (function () {
    // ---------------------------------------------------------------- sensors
    // ThingSpeak channel carrying the weather station readings.
    const WEATHER = {
        channelId: '3000045',
        readKey: '0Z0Q3YOZYC8U5CA6',
        // field -> measure. field5 is reserved for the NDIR CO2 sensor; the UI
        // hides every CO2 surface until the channel actually reports on it, so
        // this can ship before the sensor is wired.
        fields: {
            temperature: 'field1',
            humidity: 'field2',
            pressure: 'field3',
            altitude: 'field4', // collected, unused
            co2: 'field5',
        },
    };

    const weatherBase = `https://api.thingspeak.com/channels/${WEATHER.channelId}/feeds.json?api_key=${WEATHER.readKey}`;

    // ------------------------------------------------------------- check-ins
    // The symptom cluster. Rated 0-3, every one of them, at a fixed time.
    //
    // The point of rating the *cluster* rather than counting headache days is
    // that if these five co-vary as a unit, that is evidence of one underlying
    // process rather than five unrelated complaints. `analysis.js` measures it.
    const CHANNELS = [
        { key: 'sound',   label: 'Sound',   icon: 'fa-volume-high',   hint: 'Noise feels sharp, intrusive, hard to filter out' },
        { key: 'light',   label: 'Light',   icon: 'fa-sun',           hint: 'Screens or daylight feel harsh, want to squint' },
        { key: 'fog',     label: 'Fog',     icon: 'fa-brain',         hint: 'Word-finding, slow thinking, feeling underwater' },
        { key: 'neck',    label: 'Neck',    icon: 'fa-user-injured',  hint: 'Neck / shoulder / base-of-skull tightness' },
        { key: 'fatigue', label: 'Fatigue', icon: 'fa-battery-quarter', hint: 'Tiredness that sleep does not fix' },
    ];

    // Rating scale. Deliberately short labels: this has to be readable in the
    // half-second before a tap.
    const SCALE = [
        { value: 0, label: 'None',     desc: 'Absent. Would not have noticed unasked.' },
        { value: 1, label: 'Mild',     desc: 'Noticeable if I check in with myself.' },
        { value: 2, label: 'Moderate', desc: 'Present in the background all day.' },
        { value: 3, label: 'Severe',   desc: 'Dominating; shaping what I do.' },
    ];

    // Binary flags recorded alongside the ratings. These are what make lead/lag
    // analysis possible — a continuous cluster score correlated against a
    // discrete event is what reveals premonitory and postdromal windows.
    const FLAGS = [
        { key: 'headache', label: 'Headache', icon: 'fa-bolt', hint: 'Any head pain at all today, however mild' },
        { key: 'triptan',  label: 'Triptan',  icon: 'fa-pills', hint: 'Took a triptan (or other abortive) today' },
    ];

    /* Two slots a day. Morning is the anchor — it is checked as soon as the
     * monitor comes on. Evening is a window rather than a point, because
     * evenings are less predictable.
     *
     * Rating at fixed times matters: stimulant offset produces a systematic
     * afternoon dip that would otherwise smear across every channel.
     *
     * BOTH slots are point-in-time: "how am I right now", never "how was the
     * day". Summarising a day would mean the morning got counted twice, which
     * correlates the two readings by construction and would inflate the
     * apparent cohesion between channels; it also leans on recall, which is
     * exactly what is impaired on a foggy day. Two honest snapshots also show
     * within-day movement — a 3 that fell to a 1 — which a single average
     * throws away.
     *
     * The binary flags are the deliberate exception: they ask "has this
     * happened today", so a headache that came and went between slots is not
     * missed. They are OR-ed across the day in store.byDay(). */
    /* One window per slot, and rating is only possible inside it. There is no
     * "open early" grace period: rating the evening at 17:00 on one day and
     * 21:00 on the next measures two different things, and that inconsistency
     * is the noise the fixed times exist to remove. */
    const SLOTS = [
        { key: 'morning', label: 'Morning', code: 1, icon: 'fa-mug-hot',
          opensAt: 4 * 60, closesAt: 12 * 60,
          blurb: 'Rate how you feel right now, on waking.' },
        { key: 'evening', label: 'Evening', code: 2, icon: 'fa-moon',
          opensAt: 19 * 60, closesAt: 24 * 60 - 1,
          blurb: 'Rate how you feel right now — not the day as a whole.' },
    ];

    // How many days back the catch-up row will offer to backfill.
    const BACKFILL_DAYS = 5;

    // ------------------------------------------------------- sync (optional)
    // A second, PRIVATE ThingSpeak channel holding the check-ins, so phone and
    // laptop agree and clearing browser data is survivable. Credentials are
    // entered in Settings and kept in localStorage — they are deliberately not
    // committed to this public repo.
    const SYNC = {
        // field -> what it carries on the check-in channel
        fields: {
            sound: 'field1', light: 'field2', fog: 'field3', neck: 'field4',
            fatigue: 'field5', headache: 'field6', triptan: 'field7', slot: 'field8',
        },
        // The logical day/slot lives in the `status` string rather than in
        // created_at, so created_at can stay monotonically increasing (which
        // ThingSpeak's bulk endpoint requires) while edits still overwrite the
        // right entry.
        lookbackDays: 400,
        minFlushIntervalMs: 20000, // ThingSpeak allows a bulk update every 15s
    };

    // ------------------------------------------------------------- pressure
    // Barometric thresholds, loosely based on commonly-cited migraine-trigger
    // ranges. Conservative on purpose — tune them once there is enough logged
    // data to see which magnitude actually precedes a bad day.
    const RISK = {
        change3hModerate: 3,   // hPa over 3h
        change3hHigh: 5,
        change24hModerate: 5,  // hPa over 24h
        change24hHigh: 8,

        /* A failed I2C read on the BME280 returns a wild number rather than an
         * error, so the channel carries the occasional physically impossible
         * row — 679 hPa is the pressure at about 3,200 m. One of those landing
         * on the 24h anchor is what produced a "+156.3 hPa over 24h" banner.
         *
         * The bounds are the global records for sea-level pressure (870 hPa in
         * Typhoon Tip, 1084.8 hPa at Agata), so anything outside them is the
         * sensor lying, never the weather. */
        saneMin: 870,
        saneMax: 1085,

        /* Each end of a pressure change is the median of the readings within
         * this many minutes of the anchor, rather than the single nearest one.
         *
         * Taking one sample per end is what made the banner flip between
         * "rising" and "settled" every refresh: which reading sits nearest the
         * 24h mark changes as the clock moves, so one bad row alternately did
         * and did not get picked, with nothing about the weather changing. */
        anchorWindowMin: 30,
        minAnchorSamples: 2,
    };

    // Indoor CO2 bands. Above ~1000ppm CO2 independently degrades cognition,
    // which makes it a genuine confound for the fog channel specifically —
    // a closed air-conditioned room accumulates it fast. Separating "fog at 2
    // with CO2 at 1400" from "fog at 2 with CO2 at 600" tells two different
    // mechanisms apart.
    /* Airing-out detector. Clearing a room is exponential, so the useful
     * signal is not "CO2 is low" but "CO2 has stopped falling" — past that
     * point the window is only costing you cool air.
     *
     * Thresholds are in ppm/min, fitted over the last few minutes of 30s
     * samples. The figures below are measured off this room on 2026-07-26
     * rather than guessed, which is worth keeping accurate because the whole
     * ventilation strategy is derived from them:
     *
     *   climbing   +4.2 ppm/min with the door and window shut and one person
     *              in the room (665 -> 1011 ppm over 82 unbroken minutes).
     *              That is ~250 ppm/h, so a fully aired room is back past
     *              800 ppm in about 75 minutes and past 1000 in about two
     *              hours. An earlier note here said +7 ppm/min; that was a
     *              guess, and it was high.
     *   clearing   about -38 ppm/min at the start of a wide-open cross-draft,
     *              decaying exponentially as the room approaches outdoor.
     *              Fitted air exchange ~14 room volumes per hour.
     *   floor      487 ppm, against roughly 425 ppm outdoors.
     *
     * fallingSlope sits well inside the measured -38 because it has to hold
     * true near the *end* of an air-out, not at the start, and climbingSlope
     * well inside +4.2 so a slow refill still clears the badge. */
    const AIRING = {
        slopeWindowMs: 4 * 60000,   // regression window
        lookbackMs: 25 * 60000,     // how far back to look for the peak
        minDrop: 60,                // ppm below the recent peak before this counts as airing
        fallingSlope: -4,           // still worth leaving open
        climbingSlope: 2,           // refilling: window is shut again, clear the badge
        minSamples: 5,
    };

    const CO2_BANDS = [
        { max: 800,      key: 'fresh',    label: 'Fresh',    status: 'good',     note: 'Well ventilated.' },
        { max: 1200,     key: 'elevated', label: 'Elevated', status: 'warning',  note: 'Cognition measurably affected in some studies. Worth cracking a window.' },
        { max: 1600,     key: 'high',     label: 'High',     status: 'serious',  note: 'A plausible independent cause of fog. Ventilate before trusting the fog rating.' },
        { max: Infinity, key: 'veryHigh', label: 'Very high', status: 'critical', note: 'Ventilate now. Treat today\'s fog rating as confounded.' },
    ];

    /* Chart ranges for the environment section. ThingSpeak averages
     * server-side (in minutes) so the long ranges stay readable instead of
     * showing 30s noise.
     *
     * The two short ranges deliberately do not average at all. Indoors, the
     * things worth looking at happen on a timescale that 10-minute buckets
     * destroy: a room airing out drops 500 ppm in twelve minutes, and at one
     * point per bucket that is two samples and a straight line between them.
     * Unaveraged, 4h is ~480 points and 1h is ~120, both of which a line chart
     * draws happily.
     *
     * `average` is only honoured by ThingSpeak for 10, 15, 20, 30, 60, 240,
     * 720 and 1440. Any other value is *silently ignored* and you get raw rows
     * back with no indication that the parameter did nothing, so leave it null
     * when the intent is raw rather than inventing a smaller bucket.
     *
     * `step` is the expected spacing between points in minutes, which is what
     * decides how big a hole in the data has to be before the line breaks over
     * it rather than drawing across it. For the unaveraged ranges that is the
     * station's 30s posting interval. */
    const RANGES = {
        '1h':  { minutes: 60,  average: null, step: 0.5, unit: 'minute', display: 'HH:mm', label: '1 hour' },
        '4h':  { minutes: 240, average: null, step: 0.5, unit: 'hour',   display: 'HH:mm', label: '4 hours' },
        '24h': { days: 1,      average: 10,   step: 10,  unit: 'hour',   display: 'HH:mm', label: '24 hours' },
        '3d':  { days: 3,      average: 30,   step: 30,  unit: 'day',    display: 'MMM d', label: '3 days' },
        '7d':  { days: 7,      average: 60,   step: 60,  unit: 'day',    display: 'MMM d', label: '7 days' },
        '30d': { days: 30,     average: 240,  step: 240, unit: 'day',    display: 'MMM d', label: '30 days' },
    };

    /* Opening view. Short on purpose: the reason to look at this dashboard is
     * almost always "what is the room doing right now", and a 7-day window
     * answers that by flattening the last hour into three pixels. */
    const DEFAULT_RANGE = '4h';

    // ------------------------------------------------------------- refresh
    const REFRESH = {
        activeMs: 60000,        // cadence while the tab is visible
        hiddenMs: 5 * 60000,    // slower cadence while hidden (browsers throttle anyway)
        staleAfterMs: 3 * 60000,   // data older than this shows an amber pill
        veryStaleAfterMs: 15 * 60000, // ...and a red one past this
        sensorSilentMs: 20 * 60000,   // station itself has stopped reporting
        // A single measure missing this long means that sensor has failed even
        // though the station is still posting the others.
        measureStaleAfterMs: 5 * 60000,
        fetchTimeoutMs: 15000,
        backoffMs: [2000, 5000, 15000, 30000, 60000, 120000],
        heartbeatMs: 1000,      // drift detector: catches a frozen/slept tab
        driftFactor: 3,         // a tick this far behind schedule means we were frozen
    };

    // ------------------------------------------------------------- analysis
    const ANALYSIS = {
        minDaysForCohesion: 14,   // before this, correlations are noise
        minDaysForLeadLag: 21,
        minHeadacheDaysForLeadLag: 5,
        minDaysForCo2: 10,
        lagWindow: 3,             // days either side of a headache day
        heatmapDays: 45,
    };

    // --------------------------------------------------------------- colour
    // Dark-surface steps from the validated reference palette. Every value here
    // has been through scripts/validate_palette.js against surface #1a1a19:
    //   - the four environment hues pass all-pairs (worst CVD dE 6.9, which is
    //     legal because every measure also carries an icon and a text label)
    //   - the severity ramp passes the ordinal checks (monotone L, dL >= 0.06,
    //     light end 2.15:1 on surface)
    // Do not hand-edit these without re-running the validator.
    const COLOR = {
        /* Symptom severity is the one ordinal ramp in the app: one hue, stepped.
         * Level 0 is deliberately *not* a ramp step — a clear day renders as an
         * empty cell, so clear stretches read as blank space.
         *
         * Brighter means worse, which looks inverted if you are used to
         * light-mode charts where darker ink means more. On a dark surface it
         * has to be this way round: distance from the background is the only
         * thing that reads as intensity, so a dark "severe" would make the
         * worst days vanish and the clear days glow. Same convention as a
         * contribution graph in dark mode.
         *
         * The low step used to be #184f95, which sat at 2.15:1 against the
         * surface — barely distinguishable from an empty cell, which muddied
         * exactly the clear-versus-mild distinction the whole thing is for.
         * Lifted to 3.23:1; still passes the ordinal checks. */
        severity: [null, '#256abf', '#5598e7', '#b7d3f6'],
        severityInk: [null, '#ffffff', '#0b0b0b', '#0b0b0b'], // digit ink, all >= 4.5:1

        /* Environment measures. Colour follows the measure everywhere it
         * appears.
         *
         * Temperature takes the warm red, CO2 the amber, humidity a cyan.
         * Humidity is as blue as it can get while staying tellable apart from
         * pressure: pressure's violet and a true azure collapse to almost the
         * same colour under deuteranopia (dE 2.4, which is nothing), and the
         * separation only opens up once humidity is pushed toward cyan. At
         * #0098b2 the worst pair is dE 9.0. Anything bluer trades that away
         * fast — see the frontier in scripts/validate_palette.js. */
        pressure: '#9085e9',
        temperature: '#d55181',
        humidity: '#0098b2',
        co2: '#c98500',

        // Status is reserved: it only ever means good -> critical, and always
        // ships with an icon and a label so it never carries meaning by hue.
        status: {
            good: '#0ca30c',
            warning: '#fab219',
            serious: '#ec835a',
            critical: '#d03b3b',
        },

        // Diverging pair for correlations (polarity around zero).
        diverging: { neg: '#e66767', mid: '#383835', pos: '#3987e5' },

        // Chart chrome.
        surface: '#1a1a19',
        plane: '#0d0d0d',
        ink: '#ffffff',
        inkSecondary: '#c3c2b7',
        inkMuted: '#898781',
        grid: '#2c2c2a',
        axis: '#383835',
    };

    return {
        WEATHER, weatherBase, CHANNELS, SCALE, FLAGS, SLOTS, BACKFILL_DAYS,
        SYNC, RISK, CO2_BANDS, AIRING, RANGES, DEFAULT_RANGE, REFRESH,
        ANALYSIS, COLOR,
    };
})();
