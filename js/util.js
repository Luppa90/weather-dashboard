/* Small shared helpers: DOM, local-calendar dates, formatting, statistics. */
window.WD = window.WD || {};

WD.util = (function () {
    // ------------------------------------------------------------------ DOM
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k === 'html') node.innerHTML = v;
            else if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k === 'style') Object.assign(node.style, v);
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : v);
        }
        for (const child of [].concat(children)) {
            if (child === null || child === undefined || child === false) continue;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    }

    const icon = (name, extra = '') => el('i', { class: `fas ${name} ${extra}`.trim(), 'aria-hidden': 'true' });

    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
        return node;
    }

    // ---------------------------------------------------------------- dates
    // Everything user-facing is keyed by *local* calendar day. Using
    // toISOString() here would silently shift the day across midnight for any
    // timezone east or west of UTC, which would corrupt the lead/lag analysis.
    function dayKey(date = new Date()) {
        const d = new Date(date);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function dayKeyToDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function addDays(key, n) {
        const d = dayKeyToDate(key);
        d.setDate(d.getDate() + n);
        return dayKey(d);
    }

    function daysBetween(a, b) {
        // Whole days from a to b, immune to DST by normalising to noon.
        const da = dayKeyToDate(a); da.setHours(12, 0, 0, 0);
        const db = dayKeyToDate(b); db.setHours(12, 0, 0, 0);
        return Math.round((db - da) / 86400000);
    }

    const minutesOfDay = (date = new Date()) => date.getHours() * 60 + date.getMinutes();

    function formatDayLabel(key, { weekday = true } = {}) {
        const d = dayKeyToDate(key);
        const today = dayKey();
        if (key === today) return 'Today';
        if (key === addDays(today, -1)) return 'Yesterday';
        return d.toLocaleDateString(undefined, weekday
            ? { weekday: 'short', day: 'numeric', month: 'short' }
            : { day: 'numeric', month: 'short' });
    }

    function relativeTime(ms) {
        if (ms === null || ms === undefined || !isFinite(ms)) return 'never';
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 45) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ${m % 60}m ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    /* Same scale as relativeTime, but as a bare duration — for sentences that
     * supply their own tense ("has not reported for 2 hours"). */
    function duration(ms) {
        if (ms === null || ms === undefined || !isFinite(ms)) return 'an unknown time';
        const m = Math.max(1, Math.round(ms / 60000));
        if (m < 60) return plural(m, 'minute');
        const h = Math.round(m / 60);
        if (h < 48) return plural(h, 'hour');
        return plural(Math.round(h / 24), 'day');
    }

    function formatClock(minutes) {
        const h = Math.floor(minutes / 60), m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // ------------------------------------------------------------ formatting
    const signed = (v, digits = 1, unit = '') =>
        v === null || v === undefined || !isFinite(v)
            ? '—'
            : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}${unit}`;

    const num = (v, digits = 1) =>
        v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(digits);

    const pct = (v) => v === null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`;

    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

    // ------------------------------------------------------------ statistics
    const mean = (xs) => {
        const v = xs.filter(isFiniteNum);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };

    const isFiniteNum = (x) => typeof x === 'number' && isFinite(x);

    function stdev(xs) {
        const v = xs.filter(isFiniteNum);
        if (v.length < 2) return null;
        const m = mean(v);
        return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
    }

    /* Pearson correlation over pairs where both values are present.
     * With a 0/1 series on one side this is the point-biserial correlation,
     * which is what the headache-flag analysis needs. Returns null when there
     * is not enough variance to be meaningful (e.g. every day had a headache). */
    function pearson(xs, ys) {
        const pairs = [];
        for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
            if (isFiniteNum(xs[i]) && isFiniteNum(ys[i])) pairs.push([xs[i], ys[i]]);
        }
        if (pairs.length < 3) return null;
        const mx = mean(pairs.map(p => p[0]));
        const my = mean(pairs.map(p => p[1]));
        let sxy = 0, sxx = 0, syy = 0;
        for (const [x, y] of pairs) {
            sxy += (x - mx) * (y - my);
            sxx += (x - mx) ** 2;
            syy += (y - my) ** 2;
        }
        if (sxx === 0 || syy === 0) return null;
        return sxy / Math.sqrt(sxx * syy);
    }

    // ---------------------------------------------------------------- misc
    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    function download(filename, text, type = 'application/json') {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = el('a', { href: url, download: filename });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* fetch + JSON with a hard timeout, so a hung request can never stall the
     * refresh chain (a real failure mode: a socket that neither resolves nor
     * rejects leaves the dashboard frozen on stale data with no error shown). */
    async function getJSON(url, timeoutMs = 15000) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            return await res.json();
        } catch (err) {
            if (err.name === 'AbortError') throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        $, $$, el, icon, clear,
        dayKey, dayKeyToDate, addDays, daysBetween, minutesOfDay,
        formatDayLabel, relativeTime, duration, formatClock,
        signed, num, pct, plural,
        mean, stdev, pearson, isFiniteNum,
        debounce, clamp, download, getJSON,
    };
})();
