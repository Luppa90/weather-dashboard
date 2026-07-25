/* Chart rendering.
 *
 * Time series go through Chart.js. Everything else — the cluster heatmap, the
 * lead/lag bars, the cohesion matrix — is plain HTML and CSS, because those are
 * small grids of labelled cells where real DOM gives keyboard focus, text
 * selection and a table view for free.
 *
 * Colour rules followed here: severity is one ordinal blue ramp (level 0 is not
 * a step — a clear day is an empty cell); each environment measure keeps its
 * own hue everywhere it appears; status colours mean only good -> critical and
 * always ship with an icon and a label. See js/config.js.
 */
window.WD = window.WD || {};

WD.charts = (function () {
    const { COLOR, CHANNELS, RANGES } = WD.CFG;
    const { el, clear, num, signed, addDays, formatDayLabel } = WD.util;

    const charts = {};

    // ------------------------------------------------------------- tooltip
    let tip;
    function tooltip() {
        if (!tip) {
            tip = el('div', { class: 'viz-tip', role: 'tooltip', hidden: true });
            document.body.appendChild(tip);
        }
        return tip;
    }

    function attachTip(node, render) {
        const show = (e) => {
            const t = tooltip();
            clear(t).appendChild(render());
            t.hidden = false;
            const rect = node.getBoundingClientRect();
            const x = (e.clientX ?? rect.left + rect.width / 2);
            t.style.left = `${WD.util.clamp(x, 90, window.innerWidth - 90)}px`;
            t.style.top = `${rect.top - 10}px`;
        };
        const hide = () => { if (tip) tip.hidden = true; };
        node.addEventListener('mouseenter', show);
        node.addEventListener('mousemove', show);
        node.addEventListener('mouseleave', hide);
        node.addEventListener('focus', show);
        node.addEventListener('blur', hide);
    }

    const tipRow = (label, value) => el('div', { class: 'viz-tip-row' }, [
        el('span', { class: 'viz-tip-label', text: label }),
        el('span', { class: 'viz-tip-value', text: value }),
    ]);

    // ---------------------------------------------------- Chart.js defaults
    function baseOptions({ unit, display, valueFormat, color }) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 200 },
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    type: 'time',
                    time: { unit, displayFormats: { [unit]: display } },
                    ticks: { color: COLOR.inkMuted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 11 } },
                    grid: { display: false },
                    border: { color: COLOR.axis },
                },
                y: {
                    ticks: { color: COLOR.inkMuted, font: { size: 11 }, maxTicksLimit: 6 },
                    grid: { color: COLOR.grid, drawTicks: false },
                    border: { display: false },
                },
            },
            plugins: {
                legend: { display: false }, // single series: the card title names it
                tooltip: {
                    backgroundColor: '#000000',
                    borderColor: COLOR.axis,
                    borderWidth: 1,
                    titleColor: COLOR.ink,
                    bodyColor: COLOR.inkSecondary,
                    padding: 10,
                    displayColors: false,
                    callbacks: { label: (c) => valueFormat(c.parsed.y) },
                },
            },
            elements: {
                point: { radius: 0, hitRadius: 12, hoverRadius: 4, hoverBorderWidth: 2, hoverBorderColor: COLOR.surface, hoverBackgroundColor: color },
                line: { tension: 0.3, borderWidth: 2, borderJoinStyle: 'round', borderCapStyle: 'round' },
            },
        };
    }

    /* Pad the value axis so the line is not glued to the frame, without
     * inventing headroom the data does not have. */
    function axisFor(values, minPad, floor, ceil) {
        const vals = values.filter(v => typeof v === 'number' && isFinite(v));
        if (!vals.length) return {};
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const pad = Math.max(minPad, (hi - lo) * 0.2);
        const out = { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) };
        if (floor !== undefined) out.min = Math.max(floor, out.min);
        if (ceil !== undefined) out.max = Math.min(ceil, out.max);
        return out;
    }

    /* One measure, one colour, one axis. Never two measures on one plot —
     * two y-scales invent a correlation that is not in the data. */
    function lineChart(canvasId, points, opts) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const data = points.map(p => ({ x: p.t, y: p.v }));
        const values = points.map(p => p.v);
        const yAxis = axisFor(values, opts.minPad ?? 1, opts.floor, opts.ceil);
        const existing = charts[canvasId];

        if (existing) {
            existing.data.datasets[0].data = data;
            Object.assign(existing.options.scales.y, yAxis);
            existing.options.scales.x.time.unit = opts.unit;
            existing.options.scales.x.time.displayFormats = { [opts.unit]: opts.display };
            if (opts.annotations) existing.options.plugins.annotation.annotations = opts.annotations;
            existing.update('none');
            return existing;
        }

        const options = baseOptions(opts);
        Object.assign(options.scales.y, yAxis);
        if (opts.annotations) options.plugins.annotation = { annotations: opts.annotations, clip: false };

        charts[canvasId] = new Chart(canvas, {
            type: 'line',
            data: {
                datasets: [{
                    label: opts.label,
                    data,
                    borderColor: opts.color,
                    backgroundColor: `${opts.color}1a`, // ~10% wash, never a saturated block
                    fill: true,
                    spanGaps: false,
                }],
            },
            options,
        });
        return charts[canvasId];
    }

    /* Headache days as a full-day wash rather than a line: the flag is a
     * property of the day, and a line would put it at an arbitrary hour. */
    function dayAnnotations(days, legacyEvents, from, to) {
        const annotations = {};
        for (const row of days) {
            if (!row.headache) continue;
            const start = WD.util.dayKeyToDate(row.day);
            const end = WD.util.dayKeyToDate(addDays(row.day, 1));
            if (end < from || start > to) continue;
            annotations[`h-${row.day}`] = {
                type: 'box',
                xMin: start.getTime(),
                xMax: end.getTime(),
                backgroundColor: `${COLOR.status.critical}22`,
                borderWidth: 0,
                drawTime: 'beforeDatasetsDraw',
            };
        }
        for (const ev of legacyEvents) {
            const t = new Date(ev.t);
            if (t < from || t > to) continue;
            annotations[`l-${ev.t}`] = {
                type: 'line',
                scaleID: 'x',
                value: t.getTime(),
                borderColor: `${COLOR.status.serious}cc`,
                borderWidth: 1.5,
                drawTime: 'beforeDatasetsDraw',
            };
        }
        return annotations;
    }

    // ------------------------------------------------------ cluster heatmap
    /* Five channels down, days across, severity as one blue ramp. Co-variance
     * shows up as vertical stripes; genuinely clear days show up as blank
     * columns, which is the number the whole exercise is trying to establish. */
    function clusterHeatmap(container, days, { showTable = true } = {}) {
        clear(container);
        const visible = days.slice(-WD.CFG.ANALYSIS.heatmapDays);

        if (!visible.some(d => !d.missing)) {
            container.appendChild(el('p', { class: 'empty', text: 'Your first check-ins will show up here.' }));
            return;
        }

        const grid = el('div', { class: 'heatmap' });
        // repeat() will not take a custom property as its count, so the column
        // template is set here rather than in the stylesheet.
        const template = `repeat(${visible.length}, minmax(9px, 1fr))`;

        const addRow = (label, iconName, cells, extraClass = '') => {
            grid.appendChild(el('div', { class: `heat-label ${extraClass}` }, [
                iconName ? WD.util.icon(iconName) : null,
                el('span', { text: label }),
            ]));
            const track = el('div', { class: `heat-track ${extraClass}`, style: { gridTemplateColumns: template } });
            cells.forEach(cell => track.appendChild(cell));
            grid.appendChild(track);
        };

        for (const ch of CHANNELS) {
            const cells = visible.map(row => {
                const value = row.ratings?.[ch.key];
                const known = typeof value === 'number';
                const level = known ? Math.round(value) : null;
                const cell = el('div', {
                    class: `heat-cell${known ? '' : ' unrated'}${known && level === 0 ? ' zero' : ''}`,
                    tabindex: '0',
                    role: 'img',
                    'aria-label': `${ch.label} on ${formatDayLabel(row.day)}: ${known ? WD.CFG.SCALE[level].label : 'not rated'}`,
                    style: known && level > 0 ? { background: COLOR.severity[level] } : {},
                });
                attachTip(cell, () => el('div', {}, [
                    el('div', { class: 'viz-tip-title', text: formatDayLabel(row.day) }),
                    tipRow(ch.label, known ? `${level} · ${WD.CFG.SCALE[level].label}` : 'not rated'),
                    row.headache ? tipRow('Headache', 'yes') : null,
                ]));
                return cell;
            });
            addRow(ch.label, ch.icon, cells);
        }

        // Event strip: headache and triptan, as icon + colour, never colour alone.
        const eventCells = visible.map(row => {
            const cell = el('div', { class: 'heat-cell event', tabindex: '0', role: 'img' });
            let label = 'no headache logged';
            if (row.headache) {
                cell.classList.add('headache');
                cell.style.background = COLOR.status.critical;
                label = 'headache';
            }
            if (row.triptan) {
                cell.classList.add('triptan');
                label += ' + triptan';
            }
            if (row.missing) { cell.classList.add('unrated'); label = 'no check-in'; }
            cell.setAttribute('aria-label', `${formatDayLabel(row.day)}: ${label}`);
            attachTip(cell, () => el('div', {}, [
                el('div', { class: 'viz-tip-title', text: formatDayLabel(row.day) }),
                tipRow('Headache', row.headache ? 'yes' : 'no'),
                tipRow('Triptan', row.triptan ? 'yes' : 'no'),
                row.cluster !== null && row.cluster !== undefined ? tipRow('Cluster', num(row.cluster, 2)) : null,
            ]));
            return cell;
        });
        addRow('Headache', 'fa-bolt', eventCells, 'is-event');

        container.appendChild(grid);

        // Date ruler: first, last and roughly-monthly ticks only — a label per
        // column would be unreadable at 45 columns.
        const ruler = el('div', { class: 'heat-ruler' });
        ruler.appendChild(el('span', { text: formatDayLabel(visible[0].day, { weekday: false }) }));
        ruler.appendChild(el('span', { text: formatDayLabel(visible[visible.length - 1].day, { weekday: false }) }));
        container.appendChild(ruler);

        container.appendChild(legend([
            { swatch: 'transparent', label: '0 none', outline: true },
            { swatch: COLOR.severity[1], label: '1 mild' },
            { swatch: COLOR.severity[2], label: '2 moderate' },
            { swatch: COLOR.severity[3], label: '3 severe' },
            { swatch: COLOR.status.critical, label: 'headache day', icon: 'fa-bolt' },
        ]));

        if (showTable) container.appendChild(tableView(visible));
    }

    function tableView(rows) {
        const details = el('details', { class: 'table-view' });
        details.appendChild(el('summary', { text: 'Table view' }));
        const table = el('table');
        table.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Day' }),
            ...CHANNELS.map(c => el('th', { text: c.label })),
            el('th', { text: 'Cluster' }),
            el('th', { text: 'Headache' }),
            el('th', { text: 'Triptan' }),
        ])]));
        const body = el('tbody');
        for (const row of rows.slice().reverse()) {
            if (row.missing) continue;
            body.appendChild(el('tr', {}, [
                el('td', { text: row.day }),
                ...CHANNELS.map(c => el('td', { text: typeof row.ratings?.[c.key] === 'number' ? num(row.ratings[c.key], 1) : '—' })),
                el('td', { text: row.cluster === null || row.cluster === undefined ? '—' : num(row.cluster, 2) }),
                el('td', { text: row.headache ? 'yes' : 'no' }),
                el('td', { text: row.triptan ? 'yes' : 'no' }),
            ]));
        }
        table.appendChild(body);
        details.appendChild(el('div', { class: 'table-scroll' }, [table]));
        return details;
    }

    function legend(items) {
        return el('div', { class: 'viz-legend' }, items.map(item => el('span', { class: 'viz-legend-item' }, [
            item.icon ? WD.util.icon(item.icon, 'legend-icon') : el('span', {
                class: `legend-swatch${item.outline ? ' outline' : ''}`,
                style: { background: item.swatch },
            }),
            el('span', { text: item.label }),
        ])));
    }

    // -------------------------------------------------------- lead/lag bars
    /* Deviation from baseline at each offset around a headache onset. Diverging
     * because the sign is the story: bars left of zero rising above the
     * baseline is a premonitory window. */
    function leadLagChart(container, result) {
        clear(container);
        if (!result.ready) return;

        const bars = result.offsets.map(o => ({
            ...o,
            lift: o.cluster !== null && result.baseline !== null ? o.cluster - result.baseline : null,
        }));
        const magnitudes = bars.map(b => Math.abs(b.lift ?? 0));
        const scale = Math.max(0.5, ...magnitudes);
        const peak = bars.reduce((a, b) => ((b.lift ?? -9) > (a.lift ?? -9) ? b : a), bars[0]);

        const plot = el('div', { class: 'leadlag' });
        for (const bar of bars) {
            const lift = bar.lift;
            const height = lift === null ? 0 : Math.abs(lift) / scale * 50; // % of the half-height
            const positive = (lift ?? 0) >= 0;
            const column = el('div', { class: `ll-col${bar.k === 0 ? ' is-onset' : ''}` });

            const mark = el('div', {
                class: `ll-bar ${positive ? 'up' : 'down'}`,
                tabindex: '0',
                role: 'img',
                'aria-label': `${offsetLabel(bar.k)}: cluster ${signed(lift, 2)} versus baseline, from ${WD.util.plural(bar.n, 'day')}`,
                style: {
                    height: `${height}%`,
                    background: positive ? COLOR.diverging.neg : COLOR.diverging.pos,
                },
            });
            attachTip(mark, () => el('div', {}, [
                el('div', { class: 'viz-tip-title', text: offsetLabel(bar.k) }),
                tipRow('Cluster', num(bar.cluster, 2)),
                tipRow('vs baseline', signed(lift, 2)),
                tipRow('Days averaged', String(bar.n)),
            ]));

            const half = el('div', { class: 'll-half' }, [mark]);
            column.appendChild(positive ? half : el('div', { class: 'll-half' }));
            column.appendChild(positive ? el('div', { class: 'll-half' }) : half);
            column.classList.add(positive ? 'is-up' : 'is-down');

            // Direct-label the peak only. A number on every bar goes unread.
            if (bar === peak && lift !== null) {
                mark.appendChild(el('span', { class: 'll-value', text: signed(lift, 2) }));
            }
            plot.appendChild(column);
        }

        const axis = el('div', { class: 'leadlag-axis' },
            bars.map(b => el('span', { class: b.k === 0 ? 'is-onset' : '', text: b.k === 0 ? 'onset' : (b.k > 0 ? `+${b.k}` : String(b.k)) })));

        container.appendChild(el('div', { class: 'leadlag-wrap' }, [plot, axis]));
        container.appendChild(el('div', { class: 'leadlag-ends' }, [
            el('span', { text: '← days before headache' }),
            el('span', { text: 'days after →' }),
        ]));
        container.appendChild(legend([
            { swatch: COLOR.diverging.neg, label: 'above your baseline' },
            { swatch: COLOR.diverging.pos, label: 'below baseline' },
        ]));

        // Table view carries the numbers the chart deliberately does not label.
        const details = el('details', { class: 'table-view' });
        details.appendChild(el('summary', { text: 'Table view' }));
        const table = el('table');
        table.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Offset' }), el('th', { text: 'Mean cluster' }),
            el('th', { text: 'vs baseline' }), el('th', { text: 'Days' }), el('th', { text: 'r' }),
        ])]));
        const body = el('tbody');
        for (const bar of bars) {
            const corr = result.correlations.find(c => c.k === bar.k);
            body.appendChild(el('tr', {}, [
                el('td', { text: offsetLabel(bar.k) }),
                el('td', { text: num(bar.cluster, 2) }),
                el('td', { text: signed(bar.lift, 2) }),
                el('td', { text: String(bar.n) }),
                el('td', { text: corr?.r === null || corr?.r === undefined ? '—' : num(corr.r, 2) }),
            ]));
        }
        table.appendChild(body);
        details.appendChild(el('div', { class: 'table-scroll' }, [table]));
        container.appendChild(details);
    }

    const offsetLabel = (k) =>
        k === 0 ? 'Headache day' : k < 0 ? `${-k} day${k === -1 ? '' : 's'} before` : `${k} day${k === 1 ? '' : 's'} after`;

    // ------------------------------------------------------ cohesion matrix
    /* Lower triangle only — the matrix is symmetric, so showing both halves
     * doubles the ink for no information. Every cell prints its value, which
     * makes the grid its own table view. */
    function cohesionMatrix(container, result) {
        clear(container);
        if (!result.ready) return;

        // n-1 data columns: the diagonal and the mirrored upper half are dropped.
        const grid = el('div', {
            class: 'cohesion',
            style: { gridTemplateColumns: `max-content repeat(${CHANNELS.length - 1}, minmax(52px, 84px))` },
        });
        for (let i = 1; i < CHANNELS.length; i++) {
            grid.appendChild(el('div', { class: 'coh-rowlabel', text: CHANNELS[i].label }));
            for (let j = 0; j < CHANNELS.length - 1; j++) {
                if (j >= i) { grid.appendChild(el('div', { class: 'coh-cell empty' })); continue; }
                const r = result.matrix[i][j];
                const cell = el('div', {
                    class: 'coh-cell',
                    tabindex: '0',
                    'aria-label': `${CHANNELS[i].label} and ${CHANNELS[j].label}: correlation ${num(r, 2)}`,
                    style: { background: divergingFill(r) },
                    text: r === null ? '—' : num(r, 2),
                });
                if (r !== null && Math.abs(r) > 0.55) cell.classList.add('strong');
                attachTip(cell, () => el('div', {}, [
                    el('div', { class: 'viz-tip-title', text: `${CHANNELS[i].label} × ${CHANNELS[j].label}` }),
                    tipRow('Correlation', num(r, 2)),
                    tipRow('Days', String(result.n)),
                ]));
                grid.appendChild(cell);
            }
        }
        grid.appendChild(el('div', { class: 'coh-rowlabel' }));
        for (let j = 0; j < CHANNELS.length - 1; j++) {
            grid.appendChild(el('div', { class: 'coh-collabel', text: CHANNELS[j].label }));
        }
        container.appendChild(grid);
        container.appendChild(legend([
            { swatch: divergingFill(-0.8), label: 'moves oppositely' },
            { swatch: divergingFill(0), label: 'unrelated' },
            { swatch: divergingFill(0.8), label: 'moves together' },
        ]));
    }

    /* Two hues either side of a neutral gray midpoint, opacity carrying
     * magnitude. Never a hue at the midpoint — zero has to read as "nothing". */
    function divergingFill(r) {
        if (r === null || r === undefined) return 'transparent';
        const strength = WD.util.clamp(Math.abs(r), 0, 1);
        if (strength < 0.08) return COLOR.diverging.mid;
        const hue = r > 0 ? COLOR.diverging.pos : COLOR.diverging.neg;
        const alpha = Math.round(35 + strength * 210).toString(16).padStart(2, '0');
        return `${hue}${alpha}`;
    }

    // ----------------------------------------------------------- CO2 × fog
    /* Two series, so a legend is mandatory. Fog against the rest of the cluster
     * across CO2 bands: if only fog climbs, the room air is doing it. */
    function co2SplitChart(container, result) {
        clear(container);
        if (!result.ready) return;

        const maxValue = Math.max(1, ...result.buckets.flatMap(b => [b.fog ?? 0, b.rest ?? 0]));
        const groups = el('div', { class: 'grouped-bars' });

        for (const bucket of result.buckets) {
            const group = el('div', { class: 'gb-group' });
            const track = el('div', { class: 'gb-track' });
            for (const [key, value, color, label] of [
                ['fog', bucket.fog, COLOR.severity[2], 'Fog'],
                ['rest', bucket.rest, COLOR.inkMuted, 'Rest of cluster'],
            ]) {
                const bar = el('div', {
                    class: `gb-bar gb-${key}`,
                    tabindex: '0',
                    role: 'img',
                    'aria-label': `${label} at ${bucket.label} CO2: ${num(value, 2)} of 3, from ${WD.util.plural(bucket.n, 'day')}`,
                    style: { height: `${((value ?? 0) / maxValue) * 100}%`, background: color },
                });
                attachTip(bar, () => el('div', {}, [
                    el('div', { class: 'viz-tip-title', text: `${bucket.label} CO2` }),
                    tipRow('Mean CO2', `${num(bucket.meanCo2, 0)} ppm`),
                    tipRow(label, num(value, 2)),
                    tipRow('Days', String(bucket.n)),
                ]));
                track.appendChild(bar);
            }
            group.appendChild(track);
            group.appendChild(el('span', { class: 'gb-label', text: bucket.label }));
            group.appendChild(el('span', { class: 'gb-sub', text: `${WD.util.plural(bucket.n, 'day')}` }));
            groups.appendChild(group);
        }

        container.appendChild(groups);
        container.appendChild(legend([
            { swatch: COLOR.severity[2], label: 'Fog' },
            { swatch: COLOR.inkMuted, label: 'Rest of cluster (mean)' },
        ]));
    }

    // ------------------------------------------------------------ sparkline
    /* 12-or-so points of context under a stat tile. No axis, no labels — it
     * says "shape", and the tile's value says "how much". */
    function sparkline(values, color, { width = 120, height = 28 } = {}) {
        const vals = values.filter(v => typeof v === 'number' && isFinite(v));
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('class', 'sparkline');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('preserveAspectRatio', 'none');
        if (vals.length < 2) return svg;

        const lo = Math.min(...vals), hi = Math.max(...vals);
        const span = hi - lo || 1;
        const step = width / (vals.length - 1);
        const points = vals.map((v, i) => [i * step, height - 2 - ((v - lo) / span) * (height - 4)]);

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        const last = points[points.length - 1];
        dot.setAttribute('cx', last[0].toFixed(1));
        dot.setAttribute('cy', last[1].toFixed(1));
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', color);
        dot.setAttribute('stroke', COLOR.surface);
        dot.setAttribute('stroke-width', '2'); // surface ring, so it reads over the line
        svg.appendChild(dot);
        return svg;
    }

    const rangeConfig = (key) => RANGES[key];

    return {
        lineChart, dayAnnotations, clusterHeatmap, leadLagChart, cohesionMatrix,
        co2SplitChart, sparkline, legend, rangeConfig, attachTip, tipRow, offsetLabel,
    };
})();
