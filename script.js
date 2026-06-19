// --- CONFIGURATION ---
const CHANNEL_ID = '3000045';
const READ_API_KEY = '0Z0Q3YOZYC8U5CA6';
const BASE_URL = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${READ_API_KEY}`;

// Field mapping: field1=temperature, field2=humidity, field3=pressure, field4=altitude

// --- PRESSURE / MIGRAINE SETTINGS ---
// Barometric thresholds loosely based on commonly-cited migraine-trigger ranges.
// These are deliberately conservative; tune them to your own logged pattern.
const RISK = {
    change3hModerate: 3,   // hPa over 3h
    change3hHigh: 5,
    change24hModerate: 5,  // hPa over 24h
    change24hHigh: 8,
};

// Pressure chart ranges. ThingSpeak averages server-side (minutes) so longer
// ranges stay readable instead of showing 30-second noise.
const RANGES = {
    '24h': { days: 1, average: 10, unit: 'hour', display: 'HH:mm' },
    '3d':  { days: 3, average: 30, unit: 'day',  display: 'MMM d' },
    '7d':  { days: 7, average: 60, unit: 'day',  display: 'MMM d' },
};

const MIGRAINE_KEY = 'migraineEvents';

// Event types. `early` and `pressure` are the pressure-related ones worth
// correlating; `other` (coffee, tension, etc.) is logged but visually muted.
const MIGRAINE_TYPES = {
    early:    { short: 'Head pressure', color: '#FFB300', icon: 'fa-circle-exclamation', symbol: '!' },
    pressure: { short: 'Pressure migraine', color: '#FF5722', icon: 'fa-bolt', symbol: '⚡' },
    other:    { short: 'Other', color: '#9E9E9E', icon: 'fa-notes-medical', symbol: '·' },
};

// --- STATE ---
let tempValueElem, humidityValueElem, pressureValueElem, lastUpdatedElem, loaderElem, chartsElem;
let tNowElem, t3hElem, t24hElem, tRiskElem, riskCardElem, riskDetailElem, migraineListElem;
let tempChart, humidityChart, pressureChart;
let currentRange = '7d';
let pressureSeries = []; // [{ t: Date, p: Number }] for the currently-loaded range

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    tempValueElem = document.getElementById('temp-value');
    humidityValueElem = document.getElementById('humidity-value');
    pressureValueElem = document.getElementById('pressure-value');
    lastUpdatedElem = document.getElementById('last-updated');
    loaderElem = document.getElementById('loader');
    chartsElem = document.getElementById('historical-charts');
    tNowElem = document.getElementById('t-now');
    t3hElem = document.getElementById('t-3h');
    t24hElem = document.getElementById('t-24h');
    tRiskElem = document.getElementById('t-risk');
    riskCardElem = document.getElementById('risk-card');
    riskDetailElem = document.getElementById('risk-detail');
    migraineListElem = document.getElementById('migraine-list');

    // Range toggle
    document.getElementById('range-toggle').addEventListener('click', (e) => {
        const btn = e.target.closest('.range-btn');
        if (!btn) return;
        currentRange = btn.dataset.range;
        document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
        fetchPressureChart();
    });

    // Migraine logging
    document.querySelectorAll('.log-btn').forEach(btn => {
        btn.addEventListener('click', () => logMigraine(new Date(), btn.dataset.type, getNote()));
    });
    document.getElementById('log-at-btn').addEventListener('click', () => {
        const input = document.getElementById('log-at-input');
        const type = document.getElementById('log-at-type').value;
        if (input.value) logMigraine(new Date(input.value), type, getNote());
    });

    renderMigraineList();

    // Initial + periodic refresh
    fetchAll();
    setInterval(fetchAll, 60000);
});

// --- DATA ---
async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Network response was not ok: ${res.statusText}`);
    return res.json();
}

async function fetchAll() {
    const isInitialLoad = !tempChart && !humidityChart && !pressureChart;
    if (isInitialLoad) showLoader(true, 'Fetching latest data...');

    try {
        await Promise.all([fetchRecent(), fetchPressureChart(), fetchTendency()]);

        if (!isInitialLoad && lastUpdatedElem) {
            lastUpdatedElem.style.opacity = '0.5';
            setTimeout(() => { if (lastUpdatedElem) lastUpdatedElem.style.opacity = '1'; }, 300);
        }
        if (isInitialLoad) showLoader(false);
    } catch (error) {
        console.error('An error occurred during fetch or render:', error);
        if (isInitialLoad) showLoader(true, `Error: ${error.message}. Please check console.`);
    }
}

// Recent high-resolution window (30s sampling -> 360 points ≈ 3 hours)
// drives the current-condition cards and the temp/humidity trend charts.
async function fetchRecent() {
    const data = await getJSON(`${BASE_URL}&results=360`);
    if (!data || !data.feeds || data.feeds.length === 0) {
        showLoader(true, 'No data received from ThingSpeak yet. Waiting for the first update...');
        return;
    }
    updateCurrentValues(data.feeds);
    renderTempHumidityCharts(data.feeds);
}

function showLoader(isLoading, message = 'Fetching latest data...') {
    if (loaderElem) {
        loaderElem.style.display = isLoading ? 'flex' : 'none';
        const p = loaderElem.querySelector('p');
        if (isLoading && p) p.textContent = message;
    }
    if (chartsElem && !isLoading) chartsElem.style.visibility = 'visible';
}

function updateCurrentValues(feeds) {
    const latest = feeds[feeds.length - 1];

    if (tempValueElem) tempValueElem.textContent = latest.field1 ? parseFloat(latest.field1).toFixed(1) : 'N/A';
    if (humidityValueElem) humidityValueElem.textContent = latest.field2 ? parseFloat(latest.field2).toFixed(1) : 'N/A';
    if (pressureValueElem) pressureValueElem.textContent = latest.field3 ? parseFloat(latest.field3).toFixed(1) : 'N/A';

    if (lastUpdatedElem) {
        const updated = new Date(latest.created_at);
        const diffMin = Math.floor((Date.now() - updated) / 60000);
        const rel = diffMin < 1 ? 'just now' : `${diffMin} min ago`;
        lastUpdatedElem.textContent = `Last updated: ${updated.toLocaleString()} (${rel})`;
    }
}

// --- TENDENCY / RISK ---
// Uses a 2-day, 15-min-averaged series so 3h and 24h changes are robust to noise.
async function fetchTendency() {
    const data = await getJSON(`${BASE_URL}&days=2&average=15`);
    const series = toSeries(data.feeds);
    if (series.length < 2) return;

    const now = series[series.length - 1];
    const change3h = changeOver(series, 3);
    const change24h = changeOver(series, 24);

    if (tNowElem) tNowElem.textContent = now.p.toFixed(1);
    setChange(t3hElem, change3h);
    setChange(t24hElem, change24h);

    applyRisk(change3h, change24h);
}

// Change in pressure over the last `hours`, vs the reading closest to that time.
function changeOver(series, hours) {
    const target = series[series.length - 1].t.getTime() - hours * 3600 * 1000;
    let best = null;
    for (const point of series) {
        if (best === null || Math.abs(point.t - target) < Math.abs(best.t - target)) best = point;
    }
    // Reject if the closest point is way off (not enough history yet).
    if (best === null || Math.abs(best.t - target) > 2 * 3600 * 1000) return null;
    return series[series.length - 1].p - best.p;
}

function setChange(elem, change) {
    if (!elem) return;
    if (change === null) { elem.textContent = '—'; elem.className = 'tendency-value'; return; }
    const arrow = change > 0.2 ? '▲' : change < -0.2 ? '▼' : '▶';
    const cls = change > 0.2 ? 'up' : change < -0.2 ? 'down' : 'flat';
    elem.textContent = `${arrow} ${change >= 0 ? '+' : ''}${change.toFixed(1)} hPa`;
    elem.className = `tendency-value ${cls}`;
}

function applyRisk(change3h, change24h) {
    if (!tRiskElem || !riskCardElem) return;
    const a3 = change3h === null ? 0 : Math.abs(change3h);
    const a24 = change24h === null ? 0 : Math.abs(change24h);

    let level = 'low', label = 'Low', detail = 'Pressure is steady — low barometric trigger pressure.';
    if (a3 >= RISK.change3hHigh || a24 >= RISK.change24hHigh) {
        level = 'high'; label = 'Elevated';
    } else if (a3 >= RISK.change3hModerate || a24 >= RISK.change24hModerate) {
        level = 'moderate'; label = 'Moderate';
    }

    if (level !== 'low') {
        const dir = (change24h ?? change3h ?? 0) < 0 ? 'falling' : 'rising';
        detail = `Pressure is ${dir} (${fmt(change3h)} over 3h, ${fmt(change24h)} over 24h). `
            + `Rapid${dir === 'falling' ? ' drops' : ' rises'} are a common migraine trigger — worth noting how you feel.`;
    }

    tRiskElem.textContent = label;
    riskCardElem.className = `tendency-card risk-${level}`;
    if (riskDetailElem) riskDetailElem.textContent = detail;
}

function fmt(v) { return v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} hPa`; }

function toSeries(feeds) {
    if (!feeds) return [];
    return feeds
        .filter(f => f.created_at && f.field3 !== null && f.field3 !== undefined && !isNaN(parseFloat(f.field3)))
        .map(f => ({ t: new Date(f.created_at), p: parseFloat(f.field3) }));
}

// --- PRESSURE CHART ---
async function fetchPressureChart() {
    const cfg = RANGES[currentRange];
    const data = await getJSON(`${BASE_URL}&days=${cfg.days}&average=${cfg.average}`);
    pressureSeries = toSeries(data.feeds);
    renderPressureChart();
}

function renderPressureChart() {
    const canvas = document.getElementById('pressure-chart');
    if (!canvas || pressureSeries.length === 0) return;
    const cfg = RANGES[currentRange];

    const labels = pressureSeries.map(d => d.t);
    const values = pressureSeries.map(d => d.p);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max(3, (max - min) * 0.15);
    const yAxis = { min: Math.floor(min - padding), max: Math.ceil(max + padding) };

    const annotations = buildMigraineAnnotations(labels[0], labels[labels.length - 1]);

    if (pressureChart) {
        pressureChart.data.labels = labels;
        pressureChart.data.datasets[0].data = values;
        pressureChart.options.scales.y.min = yAxis.min;
        pressureChart.options.scales.y.max = yAxis.max;
        pressureChart.options.scales.x.time.unit = cfg.unit;
        pressureChart.options.scales.x.time.displayFormats = { [cfg.unit]: cfg.display };
        pressureChart.options.plugins.annotation.annotations = annotations;
        pressureChart.update('none');
        return;
    }

    pressureChart = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets: [{
            label: 'Pressure', data: values, borderColor: '#4BC0C0',
            backgroundColor: '#4BC0C033', borderWidth: 2, fill: true, spanGaps: true,
        }]},
        options: {
            responsive: true, maintainAspectRatio: true,
            scales: {
                x: { type: 'time', time: { unit: cfg.unit, displayFormats: { [cfg.unit]: cfg.display } },
                     ticks: { color: '#A0A0A0', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
                     grid: { color: '#2c2c2c' } },
                y: { ...yAxis, ticks: { color: '#A0A0A0' }, grid: { color: '#2c2c2c' } },
            },
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: '#1E1E1E', titleFont: { size: 14, weight: 'bold' },
                           bodyFont: { size: 12 }, intersect: false, mode: 'index',
                           callbacks: { label: (c) => `Pressure: ${c.formattedValue} hPa` } },
                annotation: { annotations },
            },
            elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 5 }, line: { tension: 0.3 } },
        },
    });
}

// Vertical markers for events that fall within the visible time window,
// colour-coded by type.
function buildMigraineAnnotations(minDate, maxDate) {
    const events = getMigraineEvents();
    const annotations = {};
    events.forEach((ev, i) => {
        const t = new Date(ev.t);
        if (t < minDate || t > maxDate) return;
        const cfg = MIGRAINE_TYPES[ev.type] || MIGRAINE_TYPES.pressure;
        annotations[`m${i}`] = {
            type: 'line', scaleID: 'x', value: t.getTime(),
            borderColor: cfg.color, borderWidth: 2, borderDash: [4, 4],
            label: { display: true, content: cfg.symbol, position: 'start',
                     backgroundColor: cfg.color, color: '#fff', font: { size: 11 }, padding: 3 },
        };
    });
    return annotations;
}

// --- EVENT LOG (localStorage) ---
function getNote() {
    const el = document.getElementById('log-note');
    return el ? el.value : '';
}

// Returns [{ t: ISO string, type, note }]. Migrates legacy entries that were
// stored as bare ISO strings (all treated as pressure migraines).
function getMigraineEvents() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(MIGRAINE_KEY)) || []; }
    catch { return []; }
    return raw
        .map(e => typeof e === 'string' ? { t: e, type: 'pressure', note: '' } : e)
        .filter(e => e && e.t);
}

function saveMigraineEvents(events) {
    events.sort((a, b) => a.t.localeCompare(b.t));
    localStorage.setItem(MIGRAINE_KEY, JSON.stringify(events));
}

function logMigraine(date, type = 'pressure', note = '') {
    if (isNaN(date)) return;
    if (!MIGRAINE_TYPES[type]) type = 'pressure';
    const events = getMigraineEvents();
    events.push({ t: date.toISOString(), type, note: (note || '').trim() });
    saveMigraineEvents(events);
    const noteInput = document.getElementById('log-note');
    if (noteInput) noteInput.value = '';
    renderMigraineList();
    renderPressureChart();
}

function removeMigraine(t, type) {
    const events = getMigraineEvents();
    const i = events.findIndex(e => e.t === t && e.type === type);
    if (i !== -1) events.splice(i, 1);
    saveMigraineEvents(events);
    renderMigraineList();
    renderPressureChart();
}

function renderMigraineList() {
    if (!migraineListElem) return;
    const events = getMigraineEvents().slice().reverse();
    if (events.length === 0) {
        migraineListElem.innerHTML = '<p class="empty">Nothing logged yet.</p>';
        return;
    }
    migraineListElem.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'list-label';
    label.textContent = 'Logged events';
    migraineListElem.appendChild(label);

    events.forEach(ev => {
        const cfg = MIGRAINE_TYPES[ev.type] || MIGRAINE_TYPES.pressure;
        const chip = document.createElement('span');
        chip.className = 'migraine-chip';
        chip.style.borderColor = cfg.color;
        chip.style.background = cfg.color + '1f';

        const icon = document.createElement('i');
        icon.className = `fas ${cfg.icon}`;
        icon.style.color = cfg.color;
        chip.appendChild(icon);

        const text = `${cfg.short} · ${new Date(ev.t).toLocaleString()}${ev.note ? ' · ' + ev.note : ''}`;
        chip.appendChild(document.createTextNode(' ' + text + ' '));

        const del = document.createElement('button');
        del.className = 'chip-remove';
        del.setAttribute('aria-label', 'Remove');
        del.textContent = '×';
        del.addEventListener('click', () => removeMigraine(ev.t, ev.type));
        chip.appendChild(del);

        migraineListElem.appendChild(chip);
    });
}

// --- TEMPERATURE & HUMIDITY CHARTS (recent ~3h, 30s data) ---
function renderTempHumidityCharts(feeds) {
    const cleanFeeds = feeds.filter(feed => feed.created_at);

    const MAJOR_GAP_THRESHOLD_MS = 4 * 60 * 60 * 1000;
    const GAP_THRESHOLD_MS = 10 * 60 * 1000;

    let filteredFeeds = cleanFeeds;
    let largestGapIndex = -1;
    let largestGapSize = 0;

    for (let i = 0; i < cleanFeeds.length - 1; i++) {
        const timeDiff = new Date(cleanFeeds[i + 1].created_at) - new Date(cleanFeeds[i].created_at);
        if (timeDiff > largestGapSize) { largestGapSize = timeDiff; largestGapIndex = i; }
    }
    if (largestGapSize > MAJOR_GAP_THRESHOLD_MS) filteredFeeds = cleanFeeds.slice(largestGapIndex + 1);

    const processedData = [];
    for (let i = 0; i < filteredFeeds.length; i++) {
        const currentFeed = filteredFeeds[i];
        processedData.push(currentFeed);
        if (i < filteredFeeds.length - 1) {
            const currentTime = new Date(currentFeed.created_at);
            const timeDiff = new Date(filteredFeeds[i + 1].created_at) - currentTime;
            if (timeDiff > GAP_THRESHOLD_MS) {
                processedData.push({
                    created_at: new Date(currentTime.getTime() + 60000).toISOString(),
                    field1: null, field2: null, field3: null,
                });
            }
        }
    }

    const labels = processedData.map(feed => new Date(feed.created_at));
    const tempData = processedData.map(feed => feed.field1 ? parseFloat(feed.field1) : null);
    const humidityData = processedData.map(feed => feed.field2 ? parseFloat(feed.field2) : null);

    const getChartOptions = (yAxisConfig) => ({
        responsive: true, maintainAspectRatio: true,
        scales: {
            x: { type: 'time', time: { unit: 'minute', displayFormats: { minute: 'HH:mm' } },
                 ticks: { color: '#A0A0A0', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: '#2c2c2c' } },
            y: { ...yAxisConfig, ticks: { color: '#A0A0A0' }, grid: { color: '#2c2c2c' } },
        },
        plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: '#1E1E1E', titleFont: { size: 14, weight: 'bold' }, bodyFont: { size: 12 }, intersect: false, mode: 'index' },
        },
        elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 5 }, line: { tension: 0.4 } },
    });

    const getDataset = (label, data, color) => ({
        label, data, borderColor: color, backgroundColor: `${color}33`, borderWidth: 2, fill: true, spanGaps: false,
    });

    const axisFor = (data, minPad, floor, ceil) => {
        const vals = data.filter(v => v !== null && !isNaN(v));
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const pad = Math.max(minPad, (hi - lo) * 0.2);
        const out = { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) };
        if (floor !== undefined) out.min = Math.max(floor, out.min);
        if (ceil !== undefined) out.max = Math.min(ceil, out.max);
        return out;
    };

    const tempCanvas = document.getElementById('temperature-chart');
    if (tempCanvas) {
        const tempYAxis = axisFor(tempData, 2);
        if (tempChart) {
            tempChart.data.labels = labels;
            tempChart.data.datasets[0].data = tempData;
            tempChart.options.scales.y.min = tempYAxis.min;
            tempChart.options.scales.y.max = tempYAxis.max;
            tempChart.update('none');
        } else {
            tempChart = new Chart(tempCanvas, { type: 'line', data: { labels, datasets: [getDataset('Temperature', tempData, '#FF6384')] },
                options: { ...getChartOptions(tempYAxis), plugins: { ...getChartOptions(tempYAxis).plugins, tooltip: { callbacks: { label: (c) => `Temp: ${c.formattedValue}°C` } } } } });
        }
    }

    const humidityCanvas = document.getElementById('humidity-chart');
    if (humidityCanvas) {
        const humidityYAxis = axisFor(humidityData, 5, 0, 100);
        if (humidityChart) {
            humidityChart.data.labels = labels;
            humidityChart.data.datasets[0].data = humidityData;
            humidityChart.options.scales.y.min = humidityYAxis.min;
            humidityChart.options.scales.y.max = humidityYAxis.max;
            humidityChart.update('none');
        } else {
            humidityChart = new Chart(humidityCanvas, { type: 'line', data: { labels, datasets: [getDataset('Humidity', humidityData, '#36A2EB')] },
                options: { ...getChartOptions(humidityYAxis), plugins: { ...getChartOptions(humidityYAxis).plugins, tooltip: { callbacks: { label: (c) => `Humidity: ${c.formattedValue}%` } } } } });
        }
    }
}
