/* Check-in storage.
 *
 * Local-first: every write lands in localStorage immediately and the UI never
 * waits on the network. If a private ThingSpeak channel is configured in
 * Settings, writes are also queued and pushed there, and remote entries are
 * merged back in on load — which is what keeps phone and laptop agreeing and
 * makes "cleared my browser data" survivable.
 *
 * An entry is one rating slot on one day:
 *   { day, slot, ratings: {sound,light,fog,neck,fatigue}, headache, triptan,
 *     note, at, updatedAt, deleted? }
 * keyed by `${day}|${slot}`.
 */
window.WD = window.WD || {};

WD.store = (function () {
    const { CHANNELS, SLOTS, SYNC } = WD.CFG;
    const { dayKey } = WD.util;

    const KEY_ENTRIES = 'wd.checkins';
    const KEY_LEGACY = 'wd.legacyMigraineEvents';
    const KEY_SYNC_CFG = 'wd.sync';
    const KEY_SYNC_STATE = 'wd.syncState';
    const LEGACY_SOURCE = 'migraineEvents';

    const listeners = new Set();
    let entries = {};   // `${day}|${slot}` -> entry
    let legacy = [];    // events imported from the previous dashboard
    let syncCfg = { channelId: '', writeKey: '', readKey: '', enabled: false, syncNotes: true };
    let syncState = { lastPush: 0, lastPull: 0, pending: 0, error: null, busy: false };

    const entryKey = (day, slot) => `${day}|${slot}`;

    // ------------------------------------------------------------ persistence
    function readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
    }

    function writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); }
        catch (err) { console.error(`Could not persist ${key}`, err); }
    }

    function load() {
        entries = readJSON(KEY_ENTRIES, {}) || {};
        legacy = readJSON(KEY_LEGACY, null);
        syncCfg = Object.assign(syncCfg, readJSON(KEY_SYNC_CFG, {}));
        syncState = Object.assign(syncState, readJSON(KEY_SYNC_STATE, {}), { busy: false, error: null });

        // One-time import of the previous dashboard's event log. Those entries
        // recorded *that a migraine happened* but not the symptom cluster, so
        // they are kept separately: they still count as headache days for the
        // lead/lag analysis, but they contribute no ratings.
        if (legacy === null) {
            legacy = importLegacy();
            writeJSON(KEY_LEGACY, legacy);
        }
    }

    function importLegacy() {
        const raw = readJSON(LEGACY_SOURCE, []) || [];
        return raw
            .map(e => (typeof e === 'string' ? { t: e, type: 'pressure', note: '' } : e))
            .filter(e => e && e.t && !isNaN(new Date(e.t)))
            .map(e => ({
                t: new Date(e.t).toISOString(),
                day: dayKey(new Date(e.t)),
                type: e.type || 'pressure',
                note: e.note || '',
                // "other" was the non-pressure catch-all in the old dashboard and
                // did not necessarily mean a headache.
                headache: e.type !== 'other',
            }))
            .sort((a, b) => a.t.localeCompare(b.t));
    }

    function emit() {
        writeJSON(KEY_ENTRIES, entries);
        listeners.forEach(fn => { try { fn(); } catch (err) { console.error(err); } });
    }

    const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

    // ---------------------------------------------------------------- reads
    const get = (day, slot) => {
        const e = entries[entryKey(day, slot)];
        return e && !e.deleted ? e : null;
    };

    const all = () => Object.values(entries).filter(e => !e.deleted)
        .sort((a, b) => (a.day + a.slot).localeCompare(b.day + b.slot));

    const legacyEvents = () => legacy.slice();

    /* One row per calendar day, merging the day's slots.
     * Ratings are averaged across whatever slots exist that day: with two
     * ratings the average is the better daily estimate, and with one it is just
     * that rating. Flags are OR-ed — a headache in either slot makes it a
     * headache day. Days covered only by an imported legacy event appear with
     * no ratings but headache = true. */
    function byDay() {
        const days = new Map();

        const ensure = (day) => {
            if (!days.has(day)) {
                days.set(day, {
                    day, ratings: {}, headache: false, triptan: false,
                    slots: {}, notes: [], legacyOnly: false,
                });
            }
            return days.get(day);
        };

        for (const entry of all()) {
            const row = ensure(entry.day);
            row.slots[entry.slot] = entry;
            row.headache = row.headache || !!entry.headache;
            row.triptan = row.triptan || !!entry.triptan;
            if (entry.note) row.notes.push({ slot: entry.slot, note: entry.note });
        }

        for (const row of days.values()) {
            const present = Object.values(row.slots);
            for (const ch of CHANNELS) {
                const vals = present
                    .map(e => e.ratings?.[ch.key])
                    .filter(v => typeof v === 'number');
                row.ratings[ch.key] = vals.length
                    ? vals.reduce((a, b) => a + b, 0) / vals.length
                    : null;
            }
            const rated = CHANNELS.map(c => row.ratings[c.key]).filter(v => v !== null);
            row.complete = rated.length === CHANNELS.length;
            // Mean severity across the five channels — the cluster score that
            // the lead/lag analysis correlates against headache days.
            row.cluster = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
            // A day is genuinely clear only when every channel is 0 *and* there
            // was no headache. "No headache" alone is a much weaker claim.
            row.clear = row.complete && rated.every(v => v === 0) && !row.headache;
        }

        for (const ev of legacy) {
            if (!ev.headache) continue;
            const row = ensure(ev.day);
            if (!row.slots || Object.keys(row.slots).length === 0) row.legacyOnly = true;
            row.headache = true;
        }

        return Array.from(days.values()).sort((a, b) => a.day.localeCompare(b.day));
    }

    /* Contiguous run of days ending today (or yesterday, so the streak does not
     * evaporate before the morning check-in) with at least one entry. */
    function streak() {
        const logged = new Set(all().map(e => e.day));
        const today = dayKey();
        let cursor = logged.has(today) ? today : WD.util.addDays(today, -1);
        let count = 0;
        while (logged.has(cursor)) {
            count++;
            cursor = WD.util.addDays(cursor, -1);
        }
        return count;
    }

    // --------------------------------------------------------------- writes
    function save(day, slot, data) {
        const ratings = {};
        for (const ch of CHANNELS) {
            const v = data.ratings?.[ch.key];
            ratings[ch.key] = typeof v === 'number' ? WD.util.clamp(Math.round(v), 0, 3) : null;
        }
        const entry = {
            day, slot, ratings,
            headache: !!data.headache,
            triptan: !!data.triptan,
            note: (data.note || '').trim().slice(0, 180),
            at: data.at || new Date().toISOString(),
            updatedAt: Date.now(),
        };
        entries[entryKey(day, slot)] = entry;
        queueForSync(entry);
        emit();
        return entry;
    }

    function remove(day, slot) {
        const key = entryKey(day, slot);
        if (!entries[key]) return;
        // Tombstone rather than delete, so the removal can propagate to the
        // other device instead of the remote copy resurrecting it on next pull.
        entries[key] = { day, slot, deleted: true, updatedAt: Date.now() };
        queueForSync(entries[key]);
        emit();
    }

    // ----------------------------------------------------------------- sync
    const syncConfig = () => Object.assign({}, syncCfg);
    const syncStatus = () => Object.assign({}, syncState, { pending: pendingQueue().length });

    const syncReady = () => !!(syncCfg.enabled && syncCfg.channelId && syncCfg.writeKey && syncCfg.readKey);

    function setSyncConfig(next) {
        syncCfg = Object.assign({}, syncCfg, next);
        writeJSON(KEY_SYNC_CFG, syncCfg);
        listeners.forEach(fn => fn());
    }

    const KEY_QUEUE = 'wd.syncQueue';
    const pendingQueue = () => readJSON(KEY_QUEUE, []) || [];

    function queueForSync(entry) {
        if (!syncReady()) return;
        const queue = pendingQueue().filter(q => !(q.day === entry.day && q.slot === entry.slot));
        queue.push(entry);
        writeJSON(KEY_QUEUE, queue);
    }

    /* Encode an entry into a ThingSpeak update.
     *
     * created_at is left to the server (i.e. it is the push time) so that
     * timestamps stay monotonically increasing, which the API requires. The
     * logical day and slot travel in `status` instead, which is also what makes
     * an edit overwrite the right row: on pull we keep the highest `u` per
     * day+slot rather than trusting arrival order. */
    function encode(entry) {
        const params = new URLSearchParams({ api_key: syncCfg.writeKey });
        const f = SYNC.fields;
        if (entry.deleted) {
            for (const ch of CHANNELS) params.set(f[ch.key], '');
        } else {
            for (const ch of CHANNELS) {
                const v = entry.ratings?.[ch.key];
                params.set(f[ch.key], typeof v === 'number' ? String(v) : '');
            }
            params.set(f.headache, entry.headache ? '1' : '0');
            params.set(f.triptan, entry.triptan ? '1' : '0');
        }
        const slotCode = SLOTS.find(s => s.key === entry.slot)?.code ?? 0;
        params.set(f.slot, String(slotCode));

        const bits = [
            'v1',
            `d=${entry.day}`,
            `s=${entry.slot}`,
            `u=${entry.updatedAt}`,
            entry.deleted ? 'x=1' : null,
            (!entry.deleted && entry.note && syncCfg.syncNotes) ? `n=${entry.note.replace(/\|/g, '/')}` : null,
        ].filter(Boolean);
        params.set('status', bits.join('|').slice(0, 255));
        return params;
    }

    function decode(feed) {
        const status = feed.status || '';
        if (!status.startsWith('v1|')) return null;
        // '|' is stripped from notes on the way out, so splitting on it is safe
        // and every part is a plain key=value (values may still contain '=').
        const kv = {};
        for (const part of status.split('|').slice(1)) {
            const i = part.indexOf('=');
            if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
        }
        if (!kv.d || !kv.s) return null;

        const f = SYNC.fields;
        const numField = (name) => {
            const raw = feed[f[name]];
            if (raw === null || raw === undefined || raw === '') return null;
            const v = parseFloat(raw);
            return isFinite(v) ? v : null;
        };

        if (kv.x === '1') {
            return { day: kv.d, slot: kv.s, deleted: true, updatedAt: Number(kv.u) || 0, entryId: feed.entry_id };
        }

        const ratings = {};
        for (const ch of CHANNELS) ratings[ch.key] = numField(ch.key);
        return {
            day: kv.d, slot: kv.s, ratings,
            headache: numField('headache') === 1,
            triptan: numField('triptan') === 1,
            note: kv.n || '',
            at: feed.created_at,
            updatedAt: Number(kv.u) || new Date(feed.created_at).getTime(),
            entryId: feed.entry_id,
        };
    }

    async function push() {
        if (!syncReady()) return;
        const queue = pendingQueue();
        if (!queue.length) return;

        // ThingSpeak's free tier accepts one update every 15 seconds; the queue
        // drains one entry per flush rather than failing the whole batch.
        if (Date.now() - syncState.lastPush < SYNC.minFlushIntervalMs) return;

        const entry = queue[0];
        const url = `https://api.thingspeak.com/update?${encode(entry).toString()}`;
        const res = await fetch(url, { cache: 'no-store' });
        const text = (await res.text()).trim();

        // The endpoint answers with the new entry id, or "0" when it refused
        // (almost always the rate limit) — in which case we keep the item.
        if (!res.ok || text === '0') throw new Error(`ThingSpeak refused the update${text === '0' ? ' (rate limited)' : ` (HTTP ${res.status})`}`);

        writeJSON(KEY_QUEUE, queue.slice(1));
        syncState.lastPush = Date.now();
        writeJSON(KEY_SYNC_STATE, syncState);
    }

    async function pull() {
        if (!syncReady()) return;
        const url = `https://api.thingspeak.com/channels/${syncCfg.channelId}/feeds.json`
            + `?api_key=${encodeURIComponent(syncCfg.readKey)}&days=${SYNC.lookbackDays}`;
        const data = await WD.util.getJSON(url, WD.CFG.REFRESH.fetchTimeoutMs);
        const feeds = data?.feeds || [];

        // Latest write per day+slot wins, by the updatedAt we embedded rather
        // than by arrival order.
        const best = new Map();
        for (const feed of feeds) {
            const remote = decode(feed);
            if (!remote) continue;
            const key = entryKey(remote.day, remote.slot);
            const held = best.get(key);
            if (!held || remote.updatedAt > held.updatedAt
                || (remote.updatedAt === held.updatedAt && remote.entryId > held.entryId)) {
                best.set(key, remote);
            }
        }

        let changed = 0;
        for (const [key, remote] of best) {
            const local = entries[key];
            if (local && (local.updatedAt || 0) >= remote.updatedAt) continue;
            delete remote.entryId;
            entries[key] = remote;
            changed++;
        }

        syncState.lastPull = Date.now();
        writeJSON(KEY_SYNC_STATE, syncState);
        if (changed) emit(); else listeners.forEach(fn => fn());
        return changed;
    }

    async function sync() {
        if (!syncReady() || syncState.busy) return;
        syncState.busy = true;
        syncState.error = null;
        listeners.forEach(fn => fn());
        try {
            await push();
            await pull();
        } catch (err) {
            syncState.error = err.message;
            console.warn('Check-in sync failed:', err);
        } finally {
            syncState.busy = false;
            listeners.forEach(fn => fn());
        }
    }

    // ------------------------------------------------------- export / import
    function exportJSON() {
        return JSON.stringify({
            exportedAt: new Date().toISOString(),
            version: 1,
            entries: all(),
            legacyEvents: legacy,
        }, null, 2);
    }

    function exportCSV() {
        const head = ['day', 'slot', ...CHANNELS.map(c => c.key), 'cluster', 'headache', 'triptan', 'note', 'submitted_at'];
        const rows = all().map(e => {
            const vals = CHANNELS.map(c => e.ratings[c.key]);
            const known = vals.filter(v => typeof v === 'number');
            const cluster = known.length ? (known.reduce((a, b) => a + b, 0) / known.length).toFixed(2) : '';
            return [
                e.day, e.slot, ...vals.map(v => (v === null ? '' : v)), cluster,
                e.headache ? 1 : 0, e.triptan ? 1 : 0,
                `"${(e.note || '').replace(/"/g, '""')}"`, e.at,
            ].join(',');
        });
        return [head.join(','), ...rows].join('\n');
    }

    function importJSON(text) {
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.entries)) throw new Error('Not a dashboard export.');
        let added = 0;
        for (const entry of data.entries) {
            if (!entry.day || !entry.slot) continue;
            const key = entryKey(entry.day, entry.slot);
            const local = entries[key];
            if (local && (local.updatedAt || 0) >= (entry.updatedAt || 0)) continue;
            entries[key] = entry;
            added++;
        }
        if (Array.isArray(data.legacyEvents) && !legacy.length) {
            legacy = data.legacyEvents;
            writeJSON(KEY_LEGACY, legacy);
        }
        emit();
        return added;
    }

    return {
        load, onChange,
        get, all, byDay, streak, legacyEvents,
        save, remove,
        syncConfig, setSyncConfig, syncStatus, syncReady, sync,
        exportJSON, exportCSV, importJSON,
    };
})();
