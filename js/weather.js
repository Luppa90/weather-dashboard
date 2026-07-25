/* Environmental data from the weather station's ThingSpeak channel.
 *
 * Four different views of the same channel, on purpose:
 *   recent   results=360           ~3h at 30s resolution -> the current cards
 *   range    days=N&average=M      the chart window, averaged server-side so a
 *                                  30-day view is not 30s of noise
 *   tendency days=2&average=15     robust 3h / 24h pressure change
 *   daily    days=60&average=1440  one row per day, for the correlation work
 */
window.WD = window.WD || {};

WD.weather = (function () {
    const { weatherBase, WEATHER, RANGES, RISK, CO2_BANDS, REFRESH } = WD.CFG;
    const { getJSON, dayKey, mean } = WD.util;

    const F = WEATHER.fields;

    const state = {
        latest: null,          // { temperature, humidity, pressure, co2, at }
        recent: [],            // high-resolution feeds for the last ~3h
        range: [],             // feeds for the selected chart window
        tendency: { now: null, change3h: null, change24h: null, risk: null },
        daily: [],             // [{ day, pressure, pressureSwing, temperature, humidity, co2 }]
        hasCO2: false,
        sensorAt: null,        // when the station last reported
        lastSuccessAt: null,   // when we last got data
        error: null,
        currentRange: '7d',
    };

    let dailyFetchedAt = 0;

    // ---------------------------------------------------------------- parsing
    const numOr = (raw) => {
        if (raw === null || raw === undefined || raw === '') return null;
        const v = parseFloat(raw);
        return isFinite(v) ? v : null;
    };

    /* [{ t: Date, v: Number }] for one field, dropping unparseable rows. */
    function series(feeds, field) {
        if (!feeds) return [];
        const out = [];
        for (const feed of feeds) {
            if (!feed.created_at) continue;
            const v = numOr(feed[field]);
            if (v === null) continue;
            out.push({ t: new Date(feed.created_at), v });
        }
        return out;
    }

    /* Insert an explicit null between readings more than `gapMs` apart, so the
     * line breaks over an outage instead of drawing a straight line across it. */
    function withGaps(points, gapMs) {
        const out = [];
        for (let i = 0; i < points.length; i++) {
            out.push(points[i]);
            const next = points[i + 1];
            if (next && next.t - points[i].t > gapMs) {
                out.push({ t: new Date(points[i].t.getTime() + 1000), v: null });
            }
        }
        return out;
    }

    // ----------------------------------------------------------------- fetch
    const url = (params) => `${weatherBase}&${params}`;

    async function fetchRecent() {
        const data = await getJSON(url('results=360'), REFRESH.fetchTimeoutMs);
        const feeds = (data?.feeds || []).filter(f => f.created_at);
        if (!feeds.length) throw new Error('The channel has no readings yet.');

        state.recent = feeds;
        state.hasCO2 = feeds.some(f => numOr(f[F.co2]) !== null);

        // The newest row is not guaranteed to carry every field, so read each
        // measure from the newest row that actually has it.
        const newestWith = (field) => {
            for (let i = feeds.length - 1; i >= 0; i--) {
                const v = numOr(feeds[i][field]);
                if (v !== null) return { v, at: new Date(feeds[i].created_at) };
            }
            return null;
        };

        const temperature = newestWith(F.temperature);
        const humidity = newestWith(F.humidity);
        const pressure = newestWith(F.pressure);
        const co2 = newestWith(F.co2);

        state.sensorAt = new Date(feeds[feeds.length - 1].created_at);
        state.latest = {
            temperature: temperature?.v ?? null,
            humidity: humidity?.v ?? null,
            pressure: pressure?.v ?? null,
            co2: co2?.v ?? null,
            at: state.sensorAt,
        };
    }

    async function fetchRange() {
        const cfg = RANGES[state.currentRange];
        const data = await getJSON(url(`days=${cfg.days}&average=${cfg.average}`), REFRESH.fetchTimeoutMs);
        state.range = (data?.feeds || []).filter(f => f.created_at);
    }

    async function fetchTendency() {
        const data = await getJSON(url('days=2&average=15'), REFRESH.fetchTimeoutMs);
        const points = series(data?.feeds, F.pressure);
        if (points.length < 2) return;

        const now = points[points.length - 1];
        const change3h = changeOver(points, 3);
        const change24h = changeOver(points, 24);
        state.tendency = { now: now.v, change3h, change24h, risk: assessRisk(change3h, change24h) };
    }

    /* Daily environment aggregates for the correlation work. Slow-moving, so
     * it is refetched at most twice an hour rather than every minute. */
    async function fetchDaily(force = false) {
        if (!force && Date.now() - dailyFetchedAt < 30 * 60000) return;
        const data = await getJSON(url('days=60&average=1440'), REFRESH.fetchTimeoutMs);
        const feeds = (data?.feeds || []).filter(f => f.created_at);
        state.daily = feeds.map(feed => ({
            day: dayKey(new Date(feed.created_at)),
            temperature: numOr(feed[F.temperature]),
            humidity: numOr(feed[F.humidity]),
            pressure: numOr(feed[F.pressure]),
            co2: numOr(feed[F.co2]),
        }));

        // Day-over-day pressure change is the quantity actually implicated as a
        // trigger — a steady 1005 hPa is not the same as arriving at 1005 from
        // 1018 overnight.
        for (let i = 0; i < state.daily.length; i++) {
            const prev = state.daily[i - 1];
            state.daily[i].pressureDelta =
                prev && prev.pressure !== null && state.daily[i].pressure !== null
                    ? state.daily[i].pressure - prev.pressure
                    : null;
        }
        dailyFetchedAt = Date.now();
    }

    async function refresh() {
        await Promise.all([fetchRecent(), fetchRange(), fetchTendency()]);
        state.lastSuccessAt = Date.now();
        state.error = null;
    }

    async function setRange(key) {
        if (!RANGES[key]) return;
        state.currentRange = key;
        await fetchRange();
    }

    // -------------------------------------------------------------- pressure
    /* Change over the last `hours`, against the reading closest to that moment.
     * Returns null when history does not reach back far enough, rather than
     * quietly comparing against whatever the oldest reading happens to be. */
    function changeOver(points, hours) {
        const last = points[points.length - 1];
        const target = last.t.getTime() - hours * 3600 * 1000;
        let best = null;
        for (const p of points) {
            if (!best || Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
        }
        if (!best || Math.abs(best.t - target) > 2 * 3600 * 1000) return null;
        return last.v - best.v;
    }

    function assessRisk(change3h, change24h) {
        const a3 = change3h === null ? 0 : Math.abs(change3h);
        const a24 = change24h === null ? 0 : Math.abs(change24h);

        let level = 'low', status = 'good', label = 'Settled';
        if (a3 >= RISK.change3hHigh || a24 >= RISK.change24hHigh) {
            level = 'high'; status = 'critical'; label = 'Unsettled';
        } else if (a3 >= RISK.change3hModerate || a24 >= RISK.change24hModerate) {
            level = 'moderate'; status = 'warning'; label = 'Shifting';
        }

        const direction = (change24h ?? change3h ?? 0) < 0 ? 'falling' : 'rising';
        const detail = level === 'low'
            ? 'Barometric pressure is steady. If today is a bad day, pressure is probably not why.'
            : `Pressure is ${direction} — ${WD.util.signed(change3h, 1, ' hPa')} over 3h, `
              + `${WD.util.signed(change24h, 1, ' hPa')} over 24h. Rapid change in either direction is `
              + 'among the most-reported migraine triggers.';

        return { level, status, label, detail, direction };
    }

    const co2Band = (ppm) =>
        ppm === null || ppm === undefined ? null : CO2_BANDS.find(b => ppm < b.max);

    // ------------------------------------------------------------- freshness
    /* Two different kinds of "stale", kept apart because they need different
     * reactions: our own data being old (reload it) versus the station having
     * gone quiet (go and look at the hardware). */
    function freshness() {
        const now = Date.now();
        const dataAge = state.lastSuccessAt === null ? Infinity : now - state.lastSuccessAt;
        const sensorAge = state.sensorAt === null ? Infinity : now - state.sensorAt.getTime();

        let level = 'live';
        if (!navigator.onLine) level = 'offline';
        else if (state.error) level = 'error';
        else if (dataAge > REFRESH.veryStaleAfterMs) level = 'very-stale';
        else if (dataAge > REFRESH.staleAfterMs) level = 'stale';

        return {
            level,
            dataAge,
            sensorAge,
            sensorSilent: sensorAge > REFRESH.sensorSilentMs,
        };
    }

    return {
        state, refresh, setRange, fetchDaily, series, withGaps, co2Band, freshness,
    };
})();
