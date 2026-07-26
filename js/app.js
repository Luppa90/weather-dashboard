/* Application shell: unlock, fetch, render, and stay in sync.
 *
 * The refresh logic is deliberately paranoid. Browsers freeze timers in
 * background tabs (Firefox in particular will suspend an unfocused tab
 * outright), laptops sleep, and networks drop — all of which used to leave this
 * dashboard showing hours-old numbers with no indication anything was wrong.
 * So instead of trusting one setInterval, there are five ways back to fresh
 * data, and the header always states how old what you are looking at is.
 */
window.WD = window.WD || {};

WD.app = (function () {
    const { COLOR, RANGES, REFRESH, CHANNELS, SCALE, SLOTS, ANALYSIS } = WD.CFG;
    const { $, $$, el, clear, icon, num, signed, pct, dayKey, formatDayLabel, relativeTime } = WD.util;
    const weather = WD.weather;
    const store = WD.store;

    // ------------------------------------------------------- refresh engine
    let timer = null;
    let expectedAt = 0;
    let failures = 0;
    let inFlight = false;
    let lastDayKey = dayKey();
    let lastTargetKey = '';

    async function refresh({ reason = 'timer', includeDaily = false } = {}) {
        if (inFlight) return;
        inFlight = true;
        renderStatus();
        try {
            await weather.refresh();
            failures = 0;
        } catch (err) {
            failures++;
            weather.state.error = err.message;
            console.warn(`Refresh failed (${reason}):`, err);
        } finally {
            inFlight = false;
            renderAll();
            schedule();
        }

        // The 60-day daily aggregate is a much slower request and only feeds
        // the correlation panels, so it runs after the page is already usable
        // rather than holding the current conditions behind it.
        if (includeDaily || !weather.state.daily.length) {
            weather.fetchDaily()
                .then(renderPatterns)
                .catch(err => console.warn('Daily aggregate fetch failed:', err));
        }
        // Check-in sync is independent: a weather failure must not stop it, and
        // vice versa.
        store.sync().catch(() => {});
    }

    function schedule() {
        clearTimeout(timer);
        const base = document.hidden ? REFRESH.hiddenMs : REFRESH.activeMs;
        const delay = failures
            ? REFRESH.backoffMs[Math.min(failures - 1, REFRESH.backoffMs.length - 1)]
            : base;
        expectedAt = Date.now() + delay;
        timer = setTimeout(() => refresh({ reason: 'timer' }), delay);
    }

    function refreshIfStale(reason, thresholdMs = 30000) {
        const age = weather.state.lastSuccessAt === null ? Infinity : Date.now() - weather.state.lastSuccessAt;
        if (age > thresholdMs) refresh({ reason });
        else schedule();
    }

    /* One-second heartbeat. It keeps the "x min ago" label honest, and it is
     * how a frozen tab is detected: if the scheduled refresh is long overdue,
     * the timer never fired, so fire it now. */
    function startHeartbeat() {
        setInterval(() => {
            renderStatus();

            const overdue = Date.now() - expectedAt;
            if (!inFlight && overdue > REFRESH.heartbeatMs * REFRESH.driftFactor) {
                refresh({ reason: 'drift' });
            }

            // Midnight, or a slot coming due, changes what the check-in card
            // should say — neither generates an event of its own.
            const today = dayKey();
            const target = WD.checkin.currentTarget();
            const targetKey = `${target.day}|${target.slot?.key || 'none'}|${target.state}`;
            if (today !== lastDayKey) {
                lastDayKey = today;
                WD.checkin.render();
                renderAll();
            } else if (targetKey !== lastTargetKey) {
                WD.checkin.render();
                renderGate();
            }
            lastTargetKey = targetKey;
            updateTabNudge();
        }, REFRESH.heartbeatMs);
    }

    function wireRecovery() {
        // Coming back to the tab is the single most likely moment for the data
        // on screen to be out of date.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { schedule(); return; }
            refreshIfStale('visible');
        });
        window.addEventListener('focus', () => refreshIfStale('focus', 60000));
        // bfcache restore: the page comes back with its timers dead.
        window.addEventListener('pageshow', (e) => { if (e.persisted) refresh({ reason: 'bfcache' }); });
        window.addEventListener('online', () => refresh({ reason: 'online' }));
        window.addEventListener('offline', () => renderStatus());
    }

    /* The tab title is the nudge. This dashboard lives in a pinned tab, so a
     * dot in the title is seen every time the monitor comes on — which beats a
     * notification permission prompt nobody grants. */
    function updateTabNudge() {
        const target = WD.checkin.currentTarget();
        const due = target.state === 'due' || target.state === 'missed';
        const base = 'Weather & Migraine';
        document.title = airingSettled
            ? `✓ Aired out — close up — ${base}`
            : due ? `● ${target.slot.label} check-in — ${base}` : base;
        const favicon = $('#favicon');
        if (favicon) {
            const dot = due ? COLOR.status.warning : COLOR.severity[2];
            favicon.href = 'data:image/svg+xml,' + encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
                + `<rect width="32" height="32" rx="8" fill="${COLOR.plane}"/>`
                + `<circle cx="16" cy="16" r="7" fill="${dot}"/></svg>`);
        }
    }

    // -------------------------------------------------------------- status
    function renderStatus() {
        const pill = $('#status-pill');
        const detail = $('#status-detail');
        if (!pill) return;

        const fresh = weather.freshness();
        const labels = {
            live: 'Live', stale: 'Stale', 'very-stale': 'Out of date',
            offline: 'Offline', error: 'Error',
        };
        const icons = {
            live: 'fa-circle-check', stale: 'fa-circle-half-stroke', 'very-stale': 'fa-triangle-exclamation',
            offline: 'fa-plug-circle-xmark', error: 'fa-circle-exclamation',
        };
        const level = inFlight && fresh.level === 'live' ? 'live' : fresh.level;

        clear(pill);
        pill.className = `status-pill is-${level}${inFlight ? ' is-busy' : ''}`;
        pill.appendChild(icon(icons[level]));
        pill.appendChild(el('span', { text: inFlight ? 'Updating…' : labels[level] }));

        const bits = [];
        if (weather.state.lastSuccessAt) bits.push(`Fetched ${relativeTime(fresh.dataAge)}`);
        if (weather.state.sensorAt) bits.push(`station reported ${relativeTime(fresh.sensorAge)}`);
        if (weather.state.error) bits.push(weather.state.error);
        detail.textContent = bits.join(' · ') || 'Waiting for the first reading…';

        const warning = $('#sensor-warning');
        warning.hidden = !fresh.sensorSilent || !weather.state.sensorAt;
        if (!warning.hidden) {
            clear(warning).append(
                icon('fa-tower-broadcast'),
                el('span', { text: `The station has not reported for ${WD.util.duration(fresh.sensorAge)}. The dashboard is fine — the sensor is not sending.` }));
        }
    }

    // ------------------------------------------------------- current values
    function renderCurrent() {
        const grid = $('#current-grid');
        const latest = weather.state.latest;
        if (!latest) return;
        clear(grid);

        const recentSeries = (field) => weather.series(weather.state.recent, WD.CFG.WEATHER.fields[field]).map(p => p.v).slice(-40);

        const tiles = [
            { key: 'temperature', label: 'Temperature', unit: '°C', icon: 'fa-temperature-half', color: COLOR.temperature, value: latest.temperature, digits: 1 },
            { key: 'humidity', label: 'Humidity', unit: '%', icon: 'fa-droplet', color: COLOR.humidity, value: latest.humidity, digits: 0 },
            { key: 'pressure', label: 'Pressure', unit: 'hPa', icon: 'fa-gauge-high', color: COLOR.pressure, value: latest.pressure, digits: 1, delta: weather.state.tendency.change3h, deltaLabel: 'over 3h' },
        ];
        if (weather.state.hasCO2) {
            tiles.push({ key: 'co2', label: 'CO₂', unit: 'ppm', icon: 'fa-wind', color: COLOR.co2, value: latest.co2, digits: 0, band: weather.co2Band(latest.co2) });
        }

        for (const tile of tiles) {
            /* One sensor can die while the station keeps posting the others.
             * The reading would otherwise sit there looking current forever, so
             * a stale measure is dimmed and labelled with its age instead. */
            const stale = weather.measureStale(tile.key);
            const node = el('article', { class: `stat${stale ? ' is-stale' : ''}` }, [
                el('div', { class: 'stat-head' }, [
                    icon(tile.icon, 'stat-icon'),
                    el('span', { class: 'stat-label', text: tile.label }),
                ]),
                el('div', { class: 'stat-value' }, [
                    el('span', { text: num(tile.value, tile.digits) }),
                    el('small', { text: tile.unit }),
                ]),
                stale
                    ? el('div', { class: 'badge badge-critical' }, [
                        icon('fa-triangle-exclamation'),
                        el('span', { text: `No reading for ${WD.util.duration(weather.measureAge(tile.key))}` }),
                    ])
                    : tile.delta !== undefined && tile.delta !== null
                        ? el('div', { class: `stat-delta ${tile.delta > 0.2 ? 'up' : tile.delta < -0.2 ? 'down' : 'flat'}` }, [
                            icon(tile.delta > 0.2 ? 'fa-arrow-trend-up' : tile.delta < -0.2 ? 'fa-arrow-trend-down' : 'fa-arrow-right-long'),
                            el('span', { text: `${signed(tile.delta, 1)} ${tile.deltaLabel}` }),
                        ])
                        : null,
                !stale && tile.band
                    ? el('div', { class: `badge badge-${tile.band.status}` }, [
                        icon(statusIcon(tile.band.status)),
                        el('span', { text: tile.band.label }),
                    ])
                    : null,
            ]);
            node.appendChild(WD.charts.sparkline(recentSeries(tile.key), tile.color));
            grid.appendChild(node);
        }

        // CO2 is the one measure that comes with an action, so it gets a line
        // of guidance rather than only a number.
        const co2Note = $('#co2-note');
        const band = weather.state.hasCO2 ? weather.co2Band(latest.co2) : null;

        /* While a window is actually open, the band advice is the wrong thing
         * to show — "worth cracking a window" is unhelpful when the window is
         * already open. The airing readout answers the question actually being
         * asked at that moment, which is when to shut it again. */
        const air = weather.state.hasCO2 ? weather.airing() : null;
        const co2Dead = weather.state.hasCO2 && weather.measureStale('co2');

        if (co2Dead) {
            clear(co2Note).append(
                icon('fa-triangle-exclamation'),
                el('span', {
                    text: `The CO₂ sensor has not reported for ${WD.util.duration(weather.measureAge('co2'))}, `
                        + 'while the others are still posting. Check the SCD41 — serial command x.',
                }),
            );
            co2Note.className = 'inline-note note-critical';
            co2Note.hidden = false;
        } else if (air) {
            const settled = air.state === 'settled';
            clear(co2Note).append(
                icon(settled ? 'fa-circle-check' : 'fa-wind'),
                el('span', {
                    text: settled
                        ? `Aired out at ${Math.round(air.current)} ppm — it has stopped falling, so you can close up.`
                        : `Airing: down ${Math.round(air.drop)} ppm, still falling at ${Math.abs(air.slope).toFixed(0)} ppm/min. Leave it open.`,
                }),
            );
            co2Note.className = `inline-note ${settled ? 'note-good' : 'note-info'}`;
            co2Note.hidden = false;
        } else {
            co2Note.hidden = !band || band.status === 'good';
            if (!co2Note.hidden) {
                clear(co2Note).append(icon(statusIcon(band.status)), el('span', { text: band.note }));
                co2Note.className = `inline-note note-${band.status}`;
            }
        }
        airingSettled = !!air && air.state === 'settled';
    }

    // Read by updateTabNudge so the "you can close up" cue reaches a tab that
    // is not being looked at — which is the whole point, since airing out
    // means standing by a window rather than at the screen.
    let airingSettled = false;

    const statusIcon = (status) => ({
        good: 'fa-circle-check', warning: 'fa-circle-exclamation',
        serious: 'fa-triangle-exclamation', critical: 'fa-triangle-exclamation',
    }[status] || 'fa-circle-info');

    // ------------------------------------------------------------- pressure
    function renderPressure() {
        const t = weather.state.tendency;
        const risk = t.risk;
        const banner = $('#risk-banner');
        clear(banner);

        // A silent station leaves no recent pressure history to difference.
        // Say so, rather than showing an empty box that reads as "all fine".
        if (!risk) {
            banner.className = 'risk-banner risk-none';
            banner.append(
                el('div', { class: 'risk-mark' }, [icon('fa-circle-question')]),
                el('div', { class: 'risk-body' }, [
                    el('div', { class: 'risk-head' }, [el('strong', { text: 'Pressure trend unavailable' })]),
                    el('p', { text: 'Not enough recent readings to work out a 3h or 24h change. This usually means the station has stopped reporting.' }),
                ]));
            return;
        }
        banner.className = `risk-banner risk-${risk.status}`;
        banner.append(
            el('div', { class: 'risk-mark' }, [icon(statusIcon(risk.status))]),
            el('div', { class: 'risk-body' }, [
                el('div', { class: 'risk-head' }, [
                    el('strong', { text: risk.label }),
                    el('span', { class: 'risk-nums', text: `${signed(t.change3h, 1, ' hPa')} · 3h    ${signed(t.change24h, 1, ' hPa')} · 24h` }),
                ]),
                el('p', { text: risk.detail }),
            ]));
    }

    // --------------------------------------------------------------- charts
    function renderCharts() {
        const cfg = RANGES[weather.state.currentRange];
        const feeds = weather.state.range;
        // Three missed points in a row is an outage worth breaking the line
        // over. `step` rather than `average` because the short ranges are
        // unaveraged, and there `step` is the 30s posting interval.
        const gapMs = cfg.step * 60 * 1000 * 3;
        const field = (name) => WD.CFG.WEATHER.fields[name];

        const from = feeds.length ? new Date(feeds[0].created_at) : new Date();
        const to = feeds.length ? new Date(feeds[feeds.length - 1].created_at) : new Date();
        const annotations = WD.charts.dayAnnotations(store.byDay(), store.legacyEvents(), from, to);

        WD.charts.lineChart('pressure-chart',
            weather.withGaps(weather.series(feeds, field('pressure')), gapMs), {
                label: 'Pressure', color: COLOR.pressure, unit: cfg.unit, display: cfg.display,
                valueFormat: (v) => `${num(v, 1)} hPa`, minPad: 2, annotations,
            });

        WD.charts.lineChart('temperature-chart',
            weather.withGaps(weather.series(feeds, field('temperature')), gapMs), {
                label: 'Temperature', color: COLOR.temperature, unit: cfg.unit, display: cfg.display,
                valueFormat: (v) => `${num(v, 1)} °C`, minPad: 2,
            });

        WD.charts.lineChart('humidity-chart',
            weather.withGaps(weather.series(feeds, field('humidity')), gapMs), {
                label: 'Humidity', color: COLOR.humidity, unit: cfg.unit, display: cfg.display,
                valueFormat: (v) => `${num(v, 0)} %`, minPad: 5, floor: 0, ceil: 100,
            });

        const co2Card = $('#co2-card');
        co2Card.hidden = !weather.state.hasCO2;
        if (weather.state.hasCO2) {
            WD.charts.lineChart('co2-chart',
                weather.withGaps(weather.series(feeds, field('co2')), gapMs), {
                    label: 'CO₂', color: COLOR.co2, unit: cfg.unit, display: cfg.display,
                    valueFormat: (v) => `${num(v, 0)} ppm`, minPad: 50, floor: 350,
                });
        }
    }

    // ------------------------------------------------------------- patterns
    function renderPatterns() {
        const days = WD.analysis.calendar(store.byDay());

        renderClarity(days);
        WD.charts.clusterHeatmap($('#cluster-heatmap'), days);
        renderCohesion(days);
        renderLeadLag(days);
        renderCo2Confound(days);
        renderPressureLink(days);
    }

    function renderClarity(days) {
        const result = WD.analysis.clarity(days, 30);
        const node = $('#clarity');
        clear(node);

        if (!result.ready) {
            node.appendChild(waiting(`${WD.util.plural(result.need, 'more rated day')} and this fills in.`, result.rated, 7));
            return;
        }

        // The hero figure of the whole dashboard: not "how many headache days",
        // but how many days are actually clear of the entire cluster.
        node.append(
            el('div', { class: 'hero' }, [
                el('div', { class: 'hero-figure' }, [
                    el('span', { class: 'hero-number', text: String(result.clear) }),
                    el('span', { class: 'hero-of', text: `of ${result.rated}` }),
                ]),
                el('div', { class: 'hero-body' }, [
                    el('h3', { text: 'Genuinely clear days' }),
                    el('p', { text: `Every channel at zero and no headache, over the last ${result.window} days. `
                        + `${result.headacheFree} of those ${result.tracked} days were headache-free — the gap between those two numbers `
                        + 'is the part that goes uncounted when you only track headaches.' }),
                ]),
            ]),
            el('div', { class: 'mini-stats' }, [
                miniStat(String(result.headacheDays), 'headache days', 'fa-bolt'),
                miniStat(String(result.symptomaticNoHeadache), 'symptomatic, no headache', 'fa-wave-square'),
                miniStat(pct(result.clearRate), 'of rated days clear', 'fa-feather'),
            ]));
    }

    const miniStat = (value, label, iconName) => el('div', { class: 'mini-stat' }, [
        icon(iconName), el('b', { text: value }), el('span', { text: label }),
    ]);

    function waiting(message, have, need) {
        const wrap = el('div', { class: 'waiting' });
        wrap.append(
            icon('fa-hourglass-half'),
            el('p', { text: message }));
        if (typeof have === 'number' && need) {
            const track = el('div', { class: 'progress-track' });
            track.appendChild(el('div', { class: 'progress-fill', style: { width: `${WD.util.clamp((have / need) * 100, 4, 100)}%` } }));
            wrap.appendChild(track);
            wrap.appendChild(el('span', { class: 'progress-label', text: `${have} / ${need}` }));
        }
        return wrap;
    }

    function renderCohesion(days) {
        const result = WD.analysis.cohesion(days);
        const node = $('#cohesion');
        const verdictNode = $('#cohesion-verdict');
        clear(verdictNode);

        if (!result.ready) {
            clear(node).appendChild(waiting(
                `${WD.util.plural(result.need, 'more day')} with all five channels rated.`,
                result.n, ANALYSIS.minDaysForCohesion));
            return;
        }

        verdictNode.append(
            el('div', { class: 'verdict-figure' }, [
                el('b', { text: num(result.meanR, 2) }),
                el('span', { text: 'mean correlation' }),
            ]),
            el('p', { text: result.verdict }));

        const tightest = result.perChannel[0];
        const loosest = result.perChannel[result.perChannel.length - 1];
        // Only worth naming an outlier when one actually stands apart.
        const spread = (tightest?.meanR ?? 0) - (loosest?.meanR ?? 0);
        if (tightest && loosest && tightest.key !== loosest.key && spread >= 0.1) {
            verdictNode.appendChild(el('p', { class: 'aside', text:
                `${tightest.label} moves most with the rest (r ${num(tightest.meanR, 2)}); `
                + `${loosest.label} least (r ${num(loosest.meanR, 2)}). `
                + 'A channel that sits apart from the others usually has its own cause.' }));
        }

        WD.charts.cohesionMatrix(node, result);
    }

    function renderLeadLag(days) {
        const result = WD.analysis.leadLag(days);
        const node = $('#leadlag');
        const verdictNode = $('#leadlag-verdict');
        clear(verdictNode);

        if (!result.ready) {
            clear(node);
            const parts = [];
            if (result.needDays) parts.push(WD.util.plural(result.needDays, 'more rated day'));
            if (result.needEpisodes) parts.push(`${WD.util.plural(result.needEpisodes, 'more headache episode')}`);
            verdictNode.appendChild(waiting(
                `Needs ${parts.join(' and ')}. This is the analysis worth waiting for — it measures your own premonitory and postdromal windows rather than a same-day correlation.`,
                result.ratedDays, ANALYSIS.minDaysForLeadLag));
            return;
        }

        const lines = [];
        if (result.premonitory) {
            lines.push(`The cluster is already ${num(result.premonitory.lift, 2)} above your baseline `
                + `${WD.charts.offsetLabel(result.premonitory.k).toLowerCase()} — a premonitory window of roughly ${-result.premonitory.k * 24} hours.`);
            if (result.earliestChannel) {
                lines.push(`${result.earliestChannel.label} moves furthest in that window (+${num(result.earliestChannel.lift, 2)}), so it is the channel to treat as an early warning.`);
            }
        } else {
            lines.push('No clear rise before headache days yet. Either the premonitory window is shorter than a day, or there is not enough data to resolve it.');
        }
        if (result.postdromal) {
            lines.push(`It stays ${num(result.postdromal.lift, 2)} above baseline ${WD.charts.offsetLabel(result.postdromal.k).toLowerCase()} — the postdromal tail.`);
        }

        verdictNode.append(
            el('div', { class: 'verdict-figure' }, [
                el('b', { text: result.premonitory ? `${-result.premonitory.k}d` : '—' }),
                el('span', { text: 'lead time' }),
            ]),
            el('div', {}, lines.map(text => el('p', { text }))),
            el('p', { class: 'aside', text: `From ${WD.util.plural(result.episodes, 'headache episode')} across ${WD.util.plural(result.ratedDays, 'rated day')}. `
                + 'Consecutive headache days count once, at onset, so a three-day migraine does not smear the curve.' }));

        WD.charts.leadLagChart(node, result);
    }

    function renderCo2Confound(days) {
        const card = $('#co2-analysis-card');
        if (!weather.state.hasCO2) { card.hidden = true; return; }
        card.hidden = false;

        const result = WD.analysis.co2Confound(days, weather.state.daily);
        const node = $('#co2-analysis');
        const verdictNode = $('#co2-verdict');
        clear(verdictNode);

        if (!result.ready) {
            clear(node).appendChild(waiting(
                `${WD.util.plural(result.need, 'more day')} with both a check-in and CO₂ readings.`,
                result.n, ANALYSIS.minDaysForCo2));
            return;
        }

        verdictNode.append(
            el('div', { class: 'verdict-figure' }, [
                el('b', { text: num(result.rFog, 2) }),
                el('span', { text: 'CO₂ × fog' }),
            ]),
            el('p', { text: result.verdict }),
            el('p', { class: 'aside', text: `Rest of the cluster against CO₂: r ${num(result.rRest, 2)}. `
                + 'The difference between those two numbers is what separates a stuffy room from a migraine.' }));

        WD.charts.co2SplitChart(node, result);
    }

    function renderPressureLink(days) {
        const result = WD.analysis.pressureLink(days, weather.state.daily);
        const node = $('#pressure-link');
        clear(node);

        if (!result.ready) {
            node.appendChild(waiting(
                `${WD.util.plural(result.need, 'more rated day')} with pressure history.`,
                result.n, ANALYSIS.minDaysForCohesion));
            return;
        }

        node.append(el('div', { class: 'split-compare' }, [
            compareSide('Pressure moving', `≥ ${result.threshold} hPa in a day`, result.moving, COLOR.status.warning, result.minSide),
            compareSide('Pressure settled', `< ${result.threshold} hPa in a day`, result.settled, COLOR.inkMuted, result.minSide),
        ]));

        const lift = result.moving.cluster !== null && result.settled.cluster !== null
            ? result.moving.cluster - result.settled.cluster : null;
        node.appendChild(el('p', { class: 'aside', text: lift === null
            ? `Both sides need at least ${WD.util.plural(result.minSide, 'day')} before they are worth comparing. `
              + 'Settled weather is common, so the moving side is usually the one that takes a while to fill.'
            : `On days the barometer moved, the cluster ran ${signed(lift, 2)} versus settled days `
              + `(correlation with the size of the swing: r ${num(result.rCluster, 2)}, n ${result.n}).` }));
    }

    const compareSide = (title, sub, data, color, minSide) => el('div', { class: 'compare-side' }, [
        el('span', { class: 'compare-title', text: title }),
        el('span', { class: 'compare-sub', text: sub }),
        data.enough
            ? el('div', { class: 'compare-value', style: { color } }, [
                el('b', { text: num(data.cluster, 2) }),
                el('small', { text: '/ 3 cluster' }),
            ])
            : el('div', { class: 'compare-value muted' }, [el('b', { text: '—' })]),
        el('span', { class: 'compare-foot', text: data.enough
            ? `${pct(data.headacheRate)} had a headache · ${WD.util.plural(data.n, 'day')}`
            : `only ${WD.util.plural(data.n, 'day')} so far · needs ${minSide}` }),
    ]);

    // -------------------------------------------------------------- history
    function renderHistory() {
        const node = $('#history-list');
        clear(node);
        const entries = store.all().slice().reverse().slice(0, 40);

        if (!entries.length) {
            node.appendChild(el('p', { class: 'empty', text: 'Nothing logged yet. The check-in above is the whole job.' }));
            return;
        }

        for (const entry of entries) {
            const slot = SLOTS.find(s => s.key === entry.slot);
            node.appendChild(el('div', { class: 'history-row' }, [
                el('div', { class: 'history-when' }, [
                    el('b', { text: formatDayLabel(entry.day) }),
                    el('span', {}, [icon(slot?.icon || 'fa-clock'), el('span', { text: slot?.label || entry.slot })]),
                ]),
                el('div', { class: 'history-chips' },
                    CHANNELS.map(channel => el('span', {
                        class: `done-chip level-${entry.ratings[channel.key]}`,
                        title: `${channel.label}: ${entry.ratings[channel.key]} · ${SCALE[entry.ratings[channel.key]]?.label ?? '—'}`,
                    }, [icon(channel.icon), el('b', { text: String(entry.ratings[channel.key] ?? '—') })]))),
                el('div', { class: 'history-flags' }, [
                    entry.headache ? el('span', { class: 'badge badge-critical' }, [icon('fa-bolt'), el('span', { text: 'Headache' })]) : null,
                    entry.triptan ? el('span', { class: 'badge badge-serious' }, [icon('fa-pills'), el('span', { text: 'Triptan' })]) : null,
                    entry.note ? el('span', { class: 'history-note', title: entry.note, text: entry.note }) : null,
                ]),
                el('div', { class: 'history-actions' }, [
                    el('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${entry.day} ${entry.slot}`,
                        onclick: () => WD.checkin.editEntry(entry.day, entry.slot) }, [icon('fa-pen')]),
                    el('button', { type: 'button', class: 'icon-btn danger', title: 'Delete', 'aria-label': `Delete ${entry.day} ${entry.slot}`,
                        onclick: () => {
                            if (!confirm(`Delete the ${entry.slot} check-in for ${entry.day}?`)) return;
                            store.remove(entry.day, entry.slot);
                        } }, [icon('fa-trash')]),
                ]),
            ]));
        }
    }

    // ------------------------------------------------------------- settings
    function renderSettings() {
        const cfg = store.syncConfig();
        const status = store.syncStatus();

        // A background refresh must not overwrite keys being typed, so the form
        // is only repopulated while the dialog is closed.
        if (!$('#settings-dialog').open) {
            $('#sync-channel').value = cfg.channelId || '';
            $('#sync-write').value = cfg.writeKey || '';
            $('#sync-read').value = cfg.readKey || '';
            $('#sync-enabled').checked = !!cfg.enabled;
            $('#sync-notes').checked = !!cfg.syncNotes;
        }

        const state = $('#sync-state');
        clear(state);
        if (!store.syncReady()) {
            state.append(icon('fa-circle-info'), el('span', { text: 'Sync is off. Check-ins are saved on this device only.' }));
            state.className = 'inline-note';
        } else if (status.error) {
            state.append(icon('fa-triangle-exclamation'), el('span', { text: `Last sync failed: ${status.error}` }));
            state.className = 'inline-note note-critical';
        } else {
            state.append(icon('fa-circle-check'), el('span', {
                text: `Synced ${status.lastPull ? relativeTime(Date.now() - status.lastPull) : 'never'}`
                    + (status.pending ? ` · ${WD.util.plural(status.pending, 'entry', 'entries')} waiting to upload` : ''),
            }));
            state.className = 'inline-note note-good';
        }
    }

    function wireSettings() {
        const dialog = $('#settings-dialog');
        $('#settings-open').addEventListener('click', () => { renderSettings(); dialog.showModal(); });
        $('#settings-close').addEventListener('click', () => dialog.close());

        $('#sync-form').addEventListener('submit', (e) => {
            e.preventDefault();
            store.setSyncConfig({
                channelId: $('#sync-channel').value.trim(),
                writeKey: $('#sync-write').value.trim(),
                readKey: $('#sync-read').value.trim(),
                enabled: $('#sync-enabled').checked,
                syncNotes: $('#sync-notes').checked,
            });
            renderSettings();
            WD.checkin.toast('Sync settings saved.');
            store.sync().then(renderSettings).catch(() => renderSettings());
        });

        $('#sync-now').addEventListener('click', async () => {
            await store.sync();
            renderSettings();
            renderAll();
        });

        $('#export-json').addEventListener('click', () =>
            WD.util.download(`checkins-${dayKey()}.json`, store.exportJSON()));
        $('#export-csv').addEventListener('click', () =>
            WD.util.download(`checkins-${dayKey()}.csv`, store.exportCSV(), 'text/csv'));

        $('#import-file').addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const added = store.importJSON(await file.text());
                WD.checkin.toast(`Imported ${WD.util.plural(added, 'entry', 'entries')}.`);
            } catch (err) {
                alert(`Could not import that file: ${err.message}`);
            }
            e.target.value = '';
        });

        $('#lock-now').addEventListener('click', () => WD.auth.lock());
    }

    // ---------------------------------------------------------------- gate
    function renderGate() {
        const gated = WD.checkin.gating();
        document.body.classList.toggle('gated', gated);
        $$('.gate-target').forEach(node => node.setAttribute('aria-hidden', gated ? 'true' : 'false'));
    }

    // --------------------------------------------------------------- render
    function renderAll() {
        renderStatus();
        if (weather.state.latest) {
            renderCurrent();
            renderPressure();
            renderCharts();
        }
        renderPatterns();
        renderHistory();
        renderSettings();
        renderGate();
        $('#app').classList.add('ready');
    }

    // ----------------------------------------------------------------- init
    async function init() {
        await WD.auth.unlock();
        store.load();

        WD.checkin.init($('#checkin-slot'), {
            onChange: () => { renderGate(); renderPatterns(); },
        });
        store.onChange(() => {
            WD.checkin.render();
            renderPatterns();
            renderHistory();
            renderSettings();
            renderGate();
        });
        WD.checkin.onSaved.add(() => {
            // The reveal is the reward: rating unblurs the data.
            renderGate();
            renderPatterns();
        });

        // Range toggle scopes every environment chart at once.
        $('#range-toggle').addEventListener('click', async (e) => {
            const button = e.target.closest('.range-btn');
            if (!button) return;
            $$('#range-toggle .range-btn').forEach(b => {
                const active = b === button;
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            await weather.setRange(button.dataset.range);
            renderCharts();
        });

        $('#status-pill').addEventListener('click', () => refresh({ reason: 'manual', includeDaily: true }));
        $('#refresh-now').addEventListener('click', () => refresh({ reason: 'manual', includeDaily: true }));

        wireSettings();
        wireRecovery();
        startHeartbeat();
        updateTabNudge();

        renderAll();
        await refresh({ reason: 'initial', includeDaily: true });
    }

    return { init, refresh };
})();

document.addEventListener('DOMContentLoaded', () => {
    WD.app.init().catch(err => {
        console.error('Startup failed', err);
        const detail = document.getElementById('status-detail');
        if (detail) detail.textContent = `Startup failed: ${err.message}`;
    });
});
