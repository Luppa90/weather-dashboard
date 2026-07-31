/* The analysis the tracking exists to make possible.
 *
 * Three questions, in the order they are worth asking:
 *
 *  1. Do the five channels move as a unit? If sound, light, fog, neck and
 *     fatigue rise and fall together, that is evidence of one underlying
 *     process rather than five separate complaints. `cohesion()`.
 *
 *  2. How many days are genuinely clear? Not "headache-free" — clear, meaning
 *     every channel at zero. The two numbers are usually very different, and
 *     the gap between them is the point. `clarity()`.
 *
 *  3. Does the cluster lead or lag the headache? Same-day correlation says
 *     almost nothing. If the cluster rises 24-48h before a headache day and
 *     stays elevated after it, that is a direct measurement of a personal
 *     premonitory and postdromal window. `leadLag()`.
 *
 * Everything here refuses to produce a number it cannot support, and says how
 * much more data it needs instead.
 */
window.WD = window.WD || {};

WD.analysis = (function () {
    const { CHANNELS, ANALYSIS } = WD.CFG;
    const { mean, pearson, addDays, isFiniteNum } = WD.util;

    const indexByDay = (days) => new Map(days.map(d => [d.day, d]));

    /* Every calendar day from the first record to today, so gaps in tracking
     * stay visible as gaps instead of silently closing up. */
    function calendar(days, limit) {
        if (!days.length) return [];
        const map = indexByDay(days);
        const today = WD.util.dayKey();
        let cursor = days[0].day;
        const out = [];
        while (WD.util.daysBetween(cursor, today) >= 0) {
            out.push(map.get(cursor) || { day: cursor, ratings: {}, cluster: null, headache: false, triptan: false, missing: true });
            cursor = addDays(cursor, 1);
        }
        return limit ? out.slice(-limit) : out;
    }

    // ---------------------------------------------------------------- clarity
    /* "How many genuinely clear days do I actually have?"
     * Counted only over days that were actually rated — an unrated day is
     * unknown, not clear. */
    function clarity(days, window = 30) {
        const today = WD.util.dayKey();
        const from = addDays(today, -(window - 1));
        const inWindow = days.filter(d => d.day >= from && !d.missing);
        const rated = inWindow.filter(d => d.complete);

        const headacheFree = inWindow.filter(d => !d.headache).length;
        const clear = rated.filter(d => d.clear).length;
        // A day with no headache but the cluster running is the category that
        // usually goes uncounted, and it is the one worth seeing.
        const symptomaticNoHeadache = rated.filter(d => !d.headache && !d.clear).length;

        return {
            window,
            tracked: inWindow.length,
            rated: rated.length,
            headacheFree,
            headacheDays: inWindow.filter(d => d.headache).length,
            clear,
            symptomaticNoHeadache,
            clearRate: rated.length ? clear / rated.length : null,
            ready: rated.length >= 7,
            need: Math.max(0, 7 - rated.length),
        };
    }

    // -------------------------------------------------------------- cohesion
    /* Pairwise correlation between the five channels, plus the mean
     * inter-channel correlation — the single number that answers "one process
     * or five?". */
    function cohesion(days) {
        const rated = days.filter(d => d.complete);
        if (rated.length < ANALYSIS.minDaysForCohesion) {
            return { ready: false, n: rated.length, need: ANALYSIS.minDaysForCohesion - rated.length };
        }

        const columns = {};
        for (const ch of CHANNELS) columns[ch.key] = rated.map(d => d.ratings[ch.key]);

        const matrix = [];
        const offDiagonal = [];
        for (const a of CHANNELS) {
            const row = [];
            for (const b of CHANNELS) {
                if (a.key === b.key) { row.push(1); continue; }
                const r = pearson(columns[a.key], columns[b.key]);
                row.push(r);
                if (r !== null) offDiagonal.push(r);
            }
            matrix.push(row);
        }

        const meanR = mean(offDiagonal);
        // Bands chosen to be honest about what a correlation of this size means
        // on n of this size, rather than to sound conclusive.
        let verdict;
        if (meanR === null) verdict = 'Not enough variation between days to tell yet.';
        else if (meanR >= 0.6) verdict = 'These move together strongly — consistent with one underlying process rather than five separate symptoms.';
        else if (meanR >= 0.35) verdict = 'These move together moderately. Some shared driver, but not one single switch.';
        else if (meanR >= 0.15) verdict = 'Only weakly related so far. They may be largely independent, or the record is still too short.';
        else verdict = 'No meaningful shared movement yet. Worth checking whether the ratings are varying at all.';

        // Which channel is most and least tied to the rest — the outlier is
        // often the one with its own cause (fog and CO2, for instance).
        const perChannel = CHANNELS.map((ch, i) => ({
            key: ch.key,
            label: ch.label,
            meanR: mean(matrix[i].filter((_, j) => j !== i)),
        })).sort((a, b) => (b.meanR ?? -2) - (a.meanR ?? -2));

        return { ready: true, n: rated.length, matrix, meanR, verdict, perChannel, channels: CHANNELS };
    }

    // -------------------------------------------------------------- lead/lag
    /* Headache *episode onsets* rather than headache days: a three-day migraine
     * would otherwise contribute three overlapping epochs and smear the very
     * curve we are trying to resolve. */
    function episodeOnsets(days) {
        const map = indexByDay(days);
        return days
            .filter(d => d.headache)
            .filter(d => !map.get(addDays(d.day, -1))?.headache)
            .map(d => d.day);
    }

    /* Mean cluster score at each offset around a headache onset, against the
     * baseline of days well away from any headache.
     *
     * Offset −2 means "two days before the headache started"; +2 means two
     * days after. A hump on the left is a premonitory window; a tail on the
     * right is a postdromal one. */
    function leadLag(days) {
        const rated = days.filter(d => d.complete);
        const onsets = episodeOnsets(days);

        if (rated.length < ANALYSIS.minDaysForLeadLag || onsets.length < ANALYSIS.minHeadacheDaysForLeadLag) {
            return {
                ready: false,
                ratedDays: rated.length,
                episodes: onsets.length,
                needDays: Math.max(0, ANALYSIS.minDaysForLeadLag - rated.length),
                needEpisodes: Math.max(0, ANALYSIS.minHeadacheDaysForLeadLag - onsets.length),
            };
        }

        const map = indexByDay(days);
        const W = ANALYSIS.lagWindow;
        const offsets = [];

        for (let k = -W; k <= W; k++) {
            const rows = onsets
                .map(day => map.get(addDays(day, k)))
                .filter(row => row && row.complete);
            const perChannel = {};
            for (const ch of CHANNELS) perChannel[ch.key] = mean(rows.map(r => r.ratings[ch.key]));
            offsets.push({
                k,
                n: rows.length,
                cluster: mean(rows.map(r => r.cluster)),
                perChannel,
            });
        }

        // Baseline: rated days that are more than W days from any onset.
        const nearOnset = new Set();
        for (const day of onsets) {
            for (let k = -W; k <= W; k++) nearOnset.add(addDays(day, k));
        }
        const baselineRows = rated.filter(d => !nearOnset.has(d.day));
        const baseline = mean(baselineRows.map(d => d.cluster));

        // Point-biserial correlation at each offset, as a cross-check on the
        // epoch means: cluster on day (d+k) against headache on day d.
        const correlations = [];
        for (let k = -W; k <= W; k++) {
            const xs = [], ys = [];
            for (const d of days) {
                if (d.missing) continue;
                const shifted = map.get(addDays(d.day, k));
                if (!shifted || !shifted.complete) continue;
                xs.push(shifted.cluster);
                ys.push(d.headache ? 1 : 0);
            }
            correlations.push({ k, r: pearson(xs, ys), n: xs.length });
        }

        const lift = (k) => {
            const row = offsets.find(o => o.k === k);
            return row && row.cluster !== null && baseline !== null ? row.cluster - baseline : null;
        };

        const before = offsets.filter(o => o.k < 0 && o.cluster !== null);
        const after = offsets.filter(o => o.k > 0 && o.cluster !== null);
        const peakBefore = before.length ? before.reduce((a, b) => (b.cluster > a.cluster ? b : a)) : null;
        const peakAfter = after.length ? after.reduce((a, b) => (b.cluster > a.cluster ? b : a)) : null;

        // A tenth of the 0-3 scale per channel is about the smallest difference
        // worth talking about; below that this says "nothing yet" rather than
        // dressing up noise.
        const MEANINGFUL = 0.25;
        const premonitory = peakBefore && lift(peakBefore.k) !== null && lift(peakBefore.k) >= MEANINGFUL
            ? { k: peakBefore.k, lift: lift(peakBefore.k), n: peakBefore.n } : null;
        const postdromal = peakAfter && lift(peakAfter.k) !== null && lift(peakAfter.k) >= MEANINGFUL
            ? { k: peakAfter.k, lift: lift(peakAfter.k), n: peakAfter.n } : null;

        // Which channel moves earliest — the most useful thing this can tell
        // you, because it is the one to watch as a warning sign.
        let earliestChannel = null;
        if (premonitory) {
            const baselineByChannel = {};
            for (const ch of CHANNELS) baselineByChannel[ch.key] = mean(baselineRows.map(d => d.ratings[ch.key]));
            const candidates = CHANNELS.map(ch => {
                const row = offsets.find(o => o.k === premonitory.k);
                const value = row?.perChannel[ch.key];
                const base = baselineByChannel[ch.key];
                return {
                    key: ch.key, label: ch.label,
                    lift: isFiniteNum(value) && isFiniteNum(base) ? value - base : null,
                };
            }).filter(c => c.lift !== null);
            if (candidates.length) earliestChannel = candidates.reduce((a, b) => (b.lift > a.lift ? b : a));
        }

        return {
            ready: true,
            offsets, baseline, correlations, premonitory, postdromal, earliestChannel,
            episodes: onsets.length,
            ratedDays: rated.length,
            channels: CHANNELS,
        };
    }

    // ------------------------------------------------------------ CO2 & fog
    /* Elevated CO2 is a reliable proxy for a stale, under-ventilated room —
     * not a demonstrated direct cause of cognitive impairment on its own. See
     * CFG.CO2_BANDS for the evidence behind that distinction. Stale air (of
     * which CO2 is one marker, alongside bioeffluents/VOCs/heat) is a genuine
     * confound for the fog channel specifically — and only for that channel.
     * If fog tracks CO2 while the other four do not, that separates "the room
     * was stuffy" from "the migraine cluster was rising" — two different
     * things that would otherwise be recorded as one bad day. */
    function co2Confound(days, dailyEnv) {
        const env = new Map(dailyEnv.filter(d => d.co2 !== null).map(d => [d.day, d]));
        const rows = days.filter(d => d.complete && env.has(d.day))
            .map(d => ({ ...d, co2: env.get(d.day).co2 }));

        if (rows.length < ANALYSIS.minDaysForCo2) {
            return { ready: false, n: rows.length, need: ANALYSIS.minDaysForCo2 - rows.length };
        }

        // Each day lands in exactly one band — the first whose ceiling it clears.
        const assigned = WD.CFG.CO2_BANDS.map(band => ({ band, members: [] }));
        for (const row of rows) {
            const i = WD.CFG.CO2_BANDS.findIndex(b => row.co2 < b.max);
            assigned[i === -1 ? assigned.length - 1 : i].members.push(row);
        }

        const others = CHANNELS.filter(c => c.key !== 'fog').map(c => c.key);
        const summary = assigned
            .filter(b => b.members.length > 0)
            .map(b => ({
                key: b.band.key,
                label: b.band.label,
                status: b.band.status,
                n: b.members.length,
                meanCo2: mean(b.members.map(m => m.co2)),
                fog: mean(b.members.map(m => m.ratings.fog)),
                rest: mean(b.members.map(m => mean(others.map(k => m.ratings[k])))),
            }));

        const rFog = pearson(rows.map(r => r.co2), rows.map(r => r.ratings.fog));
        const rRest = pearson(rows.map(r => r.co2), rows.map(r => mean(others.map(k => r.ratings[k]))));

        let verdict;
        if (rFog === null) verdict = 'Not enough variation in CO2 or fog to separate them yet.';
        else if (rFog >= 0.3 && (rRest === null || rFog - rRest >= 0.2)) {
            verdict = 'Fog tracks CO2 while the rest of the cluster does not — worth reading as "this room was stale" rather than "the migraine cluster is rising." Ventilate before trusting a fog rating (though direct-CO2 dosing studies mostly find no effect at typical indoor levels, so treat this as a stale-room signal, not proof CO2 itself is the cause).';
        } else if (rFog >= 0.3) {
            verdict = 'Fog rises with CO2, but so does the rest of the cluster — this looks like stuffy rooms coinciding with bad days rather than anything CO2-specific.';
        } else {
            verdict = 'No CO2-specific pattern in fog so far. Fog looks like part of the cluster rather than a room-air effect.';
        }

        return { ready: true, n: rows.length, buckets: summary, rFog, rRest, verdict };
    }

    // ------------------------------------------------------------- pressure
    /* Ties the two halves of the dashboard together: does the day's barometric
     * movement show up in the cluster, and on headache days specifically? */
    function pressureLink(days, dailyEnv) {
        const env = new Map(dailyEnv.filter(d => d.pressure !== null).map(d => [d.day, d]));
        const rows = days.filter(d => d.complete && env.has(d.day))
            .map(d => ({ ...d, delta: env.get(d.day).pressureDelta }))
            .filter(d => isFiniteNum(d.delta));

        if (rows.length < ANALYSIS.minDaysForCohesion) {
            return { ready: false, n: rows.length, need: ANALYSIS.minDaysForCohesion - rows.length };
        }

        const swing = rows.map(r => Math.abs(r.delta));
        const rCluster = pearson(swing, rows.map(r => r.cluster));
        const rHeadache = pearson(swing, rows.map(r => (r.headache ? 1 : 0)));

        const threshold = WD.CFG.RISK.change24hModerate;
        const moving = rows.filter(r => Math.abs(r.delta) >= threshold);
        const settled = rows.filter(r => Math.abs(r.delta) < threshold);

        // A side built from one or two days will happily report "100% had a
        // headache". Summarise a side only once it has enough days to mean
        // anything; the two sides are gated independently.
        const MIN_SIDE = 5;
        const side = (group) => ({
            n: group.length,
            enough: group.length >= MIN_SIDE,
            cluster: group.length >= MIN_SIDE ? mean(group.map(r => r.cluster)) : null,
            headacheRate: group.length >= MIN_SIDE ? group.filter(r => r.headache).length / group.length : null,
        });

        return {
            ready: true,
            n: rows.length,
            rCluster,
            rHeadache,
            threshold,
            minSide: MIN_SIDE,
            moving: side(moving),
            settled: side(settled),
        };
    }

    return { calendar, clarity, cohesion, leadLag, co2Confound, pressureLink, episodeOnsets };
})();
