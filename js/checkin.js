/* The daily check-in.
 *
 * Design constraints, in priority order:
 *
 *  1. Ten seconds. Five ratings and two flags, one tap each, no scrolling, no
 *     confirmation dialog. Typing `2 1 0 3 1 0 0` then Enter completes it
 *     without touching the mouse — digits set the focused row and advance.
 *  2. Ratings before data. The environment section stays blurred until the
 *     due check-in is in, because seeing a pressure crash first will bias the
 *     rating that is supposed to be independent evidence.
 *  3. Fixed times. Morning is the anchor; evening is a window, because evenings
 *     are less predictable. Rating at a consistent hour keeps the systematic
 *     afternoon dip from smearing across every channel.
 *  4. Missing a day has to be cheap to fix, or the record develops holes
 *     exactly where the interesting weeks are.
 */
window.WD = window.WD || {};

WD.checkin = (function () {
    const { CHANNELS, SCALE, FLAGS, SLOTS, BACKFILL_DAYS } = WD.CFG;
    const { $, el, clear, icon, dayKey, addDays, minutesOfDay, formatDayLabel, formatClock } = WD.util;

    let container;
    let draft = null;      // { day, slot, ratings, headache, triptan, note }
    let editing = null;    // { day, slot } when working on something other than "now"
    let peeked = false;    // the reader chose to see the data before rating
    let expanded = false;  // idle card manually opened to review or edit today
    let legendOpen = false; // "what the numbers mean", kept open across re-renders
    const onSaved = new Set();

    // --------------------------------------------------------------- timing
    /* The card only ever asks for a slot that is open *right now*. A morning
     * rating is "how am I on waking" — being asked for it at 20:00 would
     * produce a fabricated number, which is worse than a missing one. Once a
     * slot's window closes it moves to the backfill row instead, where it is
     * clearly labelled as filling in a gap. */
    function openSlot() {
        const m = minutesOfDay();
        const today = dayKey();
        for (const slot of [...SLOTS].reverse()) {
            if (m < slot.opensAt || m > slot.closesAt) continue;
            if (WD.store.get(today, slot.key)) continue;
            return { day: today, slot, state: 'due' };
        }
        return null;
    }

    /* The next window that has not opened yet — what the collapsed card
     * announces while there is nothing to rate. */
    function nextWindow() {
        const m = minutesOfDay();
        for (const slot of SLOTS) {
            if (m < slot.opensAt) return { slot, when: `from ${formatClock(slot.opensAt)}` };
        }
        return { slot: SLOTS[0], when: `tomorrow, from ${formatClock(SLOTS[0].opensAt)}` };
    }

    function currentTarget() {
        if (editing) {
            const slot = SLOTS.find(s => s.key === editing.slot);
            return { day: editing.day, slot, state: 'editing' };
        }
        return openSlot() || { day: dayKey(), slot: null, state: 'done' };
    }

    /* Whether to hold the environment data back — only while a slot is
     * genuinely open and due. A gap from earlier nags in the backfill row; it
     * does not lock the dashboard. */
    function gating() {
        if (peeked || editing) return false;
        return currentTarget().state === 'due';
    }

    // ---------------------------------------------------------------- draft
    function startDraft(day, slotKey) {
        const existing = WD.store.get(day, slotKey);
        draft = {
            day,
            slot: slotKey,
            ratings: Object.fromEntries(CHANNELS.map(c => [c.key, existing?.ratings?.[c.key] ?? null])),
            headache: existing?.headache ?? false,
            triptan: existing?.triptan ?? false,
            note: existing?.note ?? '',
        };
    }

    const draftComplete = () => draft && CHANNELS.every(c => typeof draft.ratings[c.key] === 'number');

    /* The flags ask about the whole day, and store.byDay() ORs the two slots.
     * Once the morning has recorded a yes, the evening question has only one
     * honest answer — asking it again invites momentary logic ("no pain right
     * now") whose no the OR would silently discard. The evening card shows
     * such a flag locked on yes instead. Editing the morning back to no
     * unlocks it, since this reads the morning entry live. */
    function lockedFlags() {
        if (!draft || draft.slot !== 'evening') return {};
        const morning = WD.store.get(draft.day, 'morning');
        if (!morning) return {};
        const locked = {};
        for (const flag of FLAGS) {
            if (morning[flag.key] === true) locked[flag.key] = true;
        }
        return locked;
    }

    // --------------------------------------------------------------- render
    function render() {
        if (!container) return;
        const target = currentTarget();
        clear(container);

        document.body.classList.toggle('gated', gating());

        if (target.state === 'done') {
            draft = null;
            container.appendChild(idleCard());
        } else {
            if (!draft || draft.day !== target.day || draft.slot !== target.slot.key) {
                startDraft(target.day, target.slot.key);
            }
            container.appendChild(formCard(target));
        }

        const gaps = missedSlots();
        if (gaps.length) container.appendChild(backfillRow(gaps));
    }

    // ------------------------------------------------------------ form card
    function formCard(target) {
        const card = el('section', { class: 'card checkin', 'aria-labelledby': 'checkin-title' });

        const when = target.state === 'missed'
            ? `${formatDayLabel(target.day)} · ${target.slot.label.toLowerCase()}`
            : target.state === 'editing'
                ? `Editing ${formatDayLabel(target.day)} · ${target.slot.label.toLowerCase()}`
                : `${target.slot.label} · open until ${formatClock(target.slot.closesAt)}`;

        card.appendChild(el('header', { class: 'checkin-head' }, [
            el('div', { class: 'checkin-title-wrap' }, [
                el('h2', { id: 'checkin-title' }, [icon(target.slot.icon), el('span', { text: when })]),
                el('p', { class: 'checkin-blurb', text: target.state === 'missed'
                    ? 'Backfilling. Rate it as best you remember — an approximate entry beats a hole in the record.'
                    : target.slot.blurb }),
            ]),
            streakChip(),
        ]));

        // One scale key for all five rows, rather than repeating labels per row.
        // The full anchor sentences sit behind a toggle: title tooltips do not
        // exist on touch, and four sentences permanently on screen would slow
        // the ten-second path.
        const legend = el('div', { class: 'scale-legend', id: 'scale-legend', hidden: !legendOpen },
            SCALE.map(s => el('p', {}, [
                el('b', { text: `${s.value} ${s.label}` }),
                el('span', { text: s.desc }),
            ])));
        card.appendChild(el('div', { class: 'scale-key' }, [
            ...SCALE.map(s => el('span', {}, [
                el('b', { text: String(s.value) }),
                el('span', { text: s.label }),
            ])),
            el('button', {
                type: 'button', class: 'link-btn legend-toggle',
                'aria-expanded': legendOpen ? 'true' : 'false',
                'aria-controls': 'scale-legend',
                onclick: (e) => {
                    legendOpen = !legendOpen;
                    legend.hidden = !legendOpen;
                    e.currentTarget.setAttribute('aria-expanded', legendOpen ? 'true' : 'false');
                },
            }, [icon('fa-circle-question'), el('span', { text: 'What the numbers mean' })]),
        ]));
        card.appendChild(legend);

        const form = el('form', { class: 'checkin-form', novalidate: true });
        form.addEventListener('submit', (e) => { e.preventDefault(); commit(target); });

        for (const channel of CHANNELS) {
            form.appendChild(ratingRow(channel));
        }
        // The flags are the one deliberate exception to "right now" — they ask
        // about the whole day (see the SLOTS notes in config.js). Without a
        // label saying so, the card appears to contradict its own blurb.
        form.appendChild(el('p', { class: 'flag-divider', text: 'And for the day as a whole:' }));
        // Preset here rather than in startDraft: the draft can predate the
        // morning entry that locks it (evening open, morning backfilled).
        const locked = lockedFlags();
        for (const key of Object.keys(locked)) draft[key] = true;
        for (const flag of FLAGS) {
            form.appendChild(flagRow(flag, locked[flag.key] === true));
        }

        // Note is collapsed by default: an always-visible text field reads as
        // homework and slows the common case down.
        const noteWrap = el('div', { class: 'note-wrap' });
        const noteToggle = el('button', {
            type: 'button', class: 'link-btn',
            onclick: () => {
                noteWrap.classList.toggle('open');
                if (noteWrap.classList.contains('open')) noteInput.focus();
            },
        }, [icon('fa-plus'), el('span', { text: draft.note ? 'Edit note' : 'Add a note' })]);
        const noteInput = el('input', {
            type: 'text', class: 'note-input', maxlength: '180',
            placeholder: 'Anything unusual — poor sleep, skipped meal, stuffy room…',
            value: draft.note,
            oninput: (e) => { draft.note = e.target.value; },
        });
        noteWrap.appendChild(noteToggle);
        noteWrap.appendChild(noteInput);
        if (draft.note) noteWrap.classList.add('open');
        form.appendChild(noteWrap);

        const save = el('button', { type: 'submit', class: 'btn btn-primary btn-save' },
            [icon('fa-check'), el('span', { text: 'Save check-in' })]);
        if (!draftComplete()) save.disabled = true;

        form.appendChild(el('div', { class: 'checkin-actions' }, [
            el('button', {
                type: 'button', class: 'btn btn-ghost',
                title: 'Set every channel to 0 and no headache',
                onclick: () => {
                    for (const c of CHANNELS) draft.ratings[c.key] = 0;
                    const locked = lockedFlags();
                    for (const f of FLAGS) draft[f.key] = locked[f.key] === true;
                    render();
                    setTimeout(() => container.querySelector('.btn-save')?.focus(), 0);
                },
            }, [icon('fa-feather'), el('span', { text: 'All clear' })]),
            save,
            editing ? el('button', {
                type: 'button', class: 'btn btn-ghost',
                onclick: () => { editing = null; draft = null; render(); },
            }, [el('span', { text: 'Cancel' })]) : null,
        ]));

        form.appendChild(el('p', { class: 'kbd-hint' }, [
            el('kbd', { text: '0' }), el('span', { text: '–' }), el('kbd', { text: '3' }),
            el('span', { text: ' to rate and jump to the next row · ' }),
            el('kbd', { text: 'Enter' }), el('span', { text: ' to save' }),
        ]));

        card.appendChild(form);

        if (gating()) {
            card.appendChild(el('p', { class: 'gate-note' }, [
                icon('fa-eye-slash'),
                el('span', { text: 'Today\'s weather is hidden until this is in — reading the pressure first would bias the rating. ' }),
                el('button', {
                    type: 'button', class: 'link-btn',
                    onclick: () => { peeked = true; render(); notifyChanged(); },
                }, [el('span', { text: 'Show it anyway' })]),
            ]));
        }

        return card;
    }

    /* One channel. Four buttons, roving tabindex, digits and arrows both work.
     * The buttons carry the number and a colour step; the number is what is
     * read, the colour only reinforces it. */
    function ratingRow(channel) {
        const row = el('div', { class: 'rate-row', dataset: { key: channel.key } });
        row.appendChild(el('div', { class: 'rate-label' }, [
            icon(channel.icon),
            el('span', { class: 'rate-name', text: channel.label }),
            el('span', { class: 'rate-hint', text: channel.hint }),
        ]));

        const group = el('div', {
            class: 'rate-group', role: 'radiogroup',
            'aria-label': `${channel.label}, 0 to 3`,
        });
        const current = draft.ratings[channel.key];

        SCALE.forEach((step, i) => {
            const selected = current === step.value;
            const button = el('button', {
                type: 'button',
                class: `rate-btn level-${step.value}${selected ? ' selected' : ''}`,
                role: 'radio',
                'aria-checked': selected ? 'true' : 'false',
                'aria-label': `${channel.label}: ${step.value}, ${step.label}`,
                title: step.desc,
                tabindex: selected || (current === null && i === 0) ? '0' : '-1',
                onclick: () => setRating(channel.key, step.value, { advance: true }),
            }, [el('span', { text: String(step.value) })]);
            group.appendChild(button);
        });

        group.addEventListener('keydown', (e) => handleKeys(e, group, (v) => setRating(channel.key, v, { advance: true }), 0, 3));
        row.appendChild(group);
        return row;
    }

    function flagRow(flag, locked = false) {
        const row = el('div', { class: `rate-row flag-row${locked ? ' locked' : ''}`, dataset: { key: flag.key } });
        row.appendChild(el('div', { class: 'rate-label' }, [
            icon(flag.icon),
            el('span', { class: 'rate-name', text: flag.label }),
            el('span', {
                class: 'rate-hint',
                text: locked ? 'Already a yes this morning, and it covers the whole day' : flag.hint,
            }),
        ]));

        const group = el('div', { class: 'rate-group flag-group', role: 'radiogroup', 'aria-label': flag.label });
        [['No', false, 0], ['Yes', true, 1]].forEach(([label, value, digit], i) => {
            const selected = draft[flag.key] === value;
            group.appendChild(el('button', {
                type: 'button',
                class: `rate-btn flag-btn${selected ? ' selected' : ''}${value ? ' is-yes' : ''}`,
                role: 'radio',
                'aria-checked': selected ? 'true' : 'false',
                'aria-label': `${flag.label}: ${label}`,
                disabled: locked,
                tabindex: !locked && (selected || (draft[flag.key] === undefined && i === 0)) ? '0' : '-1',
                onclick: () => setFlag(flag.key, value, { advance: true }),
                dataset: { digit: String(digit) },
            }, [el('span', { text: label })]));
        });
        if (!locked) {
            group.addEventListener('keydown', (e) => handleKeys(e, group, (v) => setFlag(flag.key, v === 1, { advance: true }), 0, 1));
        }
        row.appendChild(group);
        return row;
    }

    /* Digits set a value and move on; arrows nudge within the row. Both are
     * handled in one place so the two row types behave identically. */
    function handleKeys(event, group, apply, min, max) {
        const buttons = Array.from(group.querySelectorAll('button'));
        const index = buttons.indexOf(document.activeElement);

        if (/^[0-9]$/.test(event.key)) {
            const value = Number(event.key);
            if (value < min || value > max) return;
            event.preventDefault();
            apply(value);
            return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            const next = buttons[Math.min(buttons.length - 1, index + 1)];
            next?.click();
            next?.focus();
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            const prev = buttons[Math.max(0, index - 1)];
            prev?.click();
            prev?.focus();
        }
    }

    function setRating(key, value, { advance } = {}) {
        draft.ratings[key] = value;
        repaint();
        if (advance) focusNextRow(key);
    }

    function setFlag(key, value, { advance } = {}) {
        draft[key] = value;
        repaint();
        if (advance) focusNextRow(key);
    }

    /* Repaint selection state in place. A full re-render here would drop focus
     * mid-keyboard-run and break the ten-second path. */
    function repaint() {
        const root = container.querySelector('.checkin-form');
        if (!root) return;

        for (const channel of CHANNELS) {
            const row = root.querySelector(`.rate-row[data-key="${channel.key}"]`);
            const value = draft.ratings[channel.key];
            row.querySelectorAll('button').forEach((button, i) => {
                const selected = value === SCALE[i].value;
                button.classList.toggle('selected', selected);
                button.setAttribute('aria-checked', selected ? 'true' : 'false');
                button.tabIndex = selected || (value === null && i === 0) ? 0 : -1;
            });
            row.classList.toggle('answered', typeof value === 'number');
        }
        for (const flag of FLAGS) {
            const row = root.querySelector(`.rate-row[data-key="${flag.key}"]`);
            if (row.classList.contains('locked')) continue;
            row.querySelectorAll('button').forEach((button, i) => {
                const selected = draft[flag.key] === (i === 1);
                button.classList.toggle('selected', selected);
                button.setAttribute('aria-checked', selected ? 'true' : 'false');
                button.tabIndex = selected ? 0 : -1;
            });
            row.classList.add('answered');
        }

        const save = root.querySelector('.btn-save');
        if (save) save.disabled = !draftComplete();
        const progress = CHANNELS.filter(c => typeof draft.ratings[c.key] === 'number').length;
        container.querySelector('.checkin')?.style.setProperty('--progress', `${(progress / CHANNELS.length) * 100}%`);
    }

    function focusNextRow(fromKey) {
        const locked = lockedFlags();
        const order = [...CHANNELS.map(c => c.key), ...FLAGS.map(f => f.key)].filter(key => !locked[key]);
        const next = order[order.indexOf(fromKey) + 1];
        const root = container.querySelector('.checkin-form');
        if (!root) return;
        if (!next) {
            const save = root.querySelector('.btn-save');
            if (!save?.disabled) save?.focus();
            return;
        }
        const target = root.querySelector(`.rate-row[data-key="${next}"] button[tabindex="0"]`)
            || root.querySelector(`.rate-row[data-key="${next}"] button`);
        target?.focus();
    }

    function commit(target) {
        if (!draftComplete()) return;
        // Snapshot first: saving fires the store's change listeners, which
        // re-render this card and replace `draft` out from under us.
        const saved = { ...draft };
        WD.store.save(saved.day, saved.slot, saved);
        editing = null;
        draft = null;
        render();
        toast(saved.day === dayKey() && target.state !== 'editing'
            ? 'Saved. Here is what the air was doing.'
            : `${formatDayLabel(saved.day)} saved.`);
        onSaved.forEach(fn => fn());
        notifyChanged();
    }

    // ------------------------------------------------------------ idle card
    /* No window is open, so there is nothing to do — collapse to one line.
     * Expanding shows what was logged today and lets it be corrected. */
    function idleCard() {
        const today = dayKey();
        const doneToday = SLOTS.map(s => ({ slot: s, entry: WD.store.get(today, s.key) })).filter(x => x.entry);
        const next = nextWindow();

        const card = el('section', { class: `card checkin is-idle${expanded ? ' is-expanded' : ''}` });

        card.appendChild(el('button', {
            type: 'button',
            class: 'checkin-collapsed',
            'aria-expanded': expanded ? 'true' : 'false',
            onclick: () => { expanded = !expanded; render(); },
        }, [
            icon(next.slot.icon, 'collapsed-icon'),
            el('span', { class: 'collapsed-text' }, [
                el('strong', { text: `Next: ${next.slot.label.toLowerCase()} check-in` }),
                el('span', { class: 'collapsed-when', text: next.when }),
            ]),
            doneToday.length
                ? el('span', { class: 'collapsed-done' }, [
                    icon('fa-circle-check'),
                    el('span', { text: `${doneToday.length} of ${SLOTS.length} today` }),
                ])
                : null,
            streakChip(),
            icon(expanded ? 'fa-chevron-up' : 'fa-chevron-down', 'collapsed-chevron'),
        ]));

        if (expanded) card.appendChild(doneSummary(doneToday));
        return card;
    }

    function doneSummary(doneToday) {
        const summary = el('div', { class: 'done-summary' });
        if (!doneToday.length) {
            summary.appendChild(el('p', { class: 'empty', text: 'Nothing logged today yet.' }));
            return summary;
        }
        for (const { slot, entry } of doneToday) {
            const chips = CHANNELS.map(channel => {
                const value = entry.ratings[channel.key];
                return el('span', {
                    class: `done-chip level-${value}`,
                    title: `${channel.label}: ${value} · ${SCALE[value]?.label ?? ''}`,
                }, [icon(channel.icon), el('b', { text: String(value) })]);
            });
            summary.appendChild(el('div', { class: 'done-slot' }, [
                el('span', { class: 'done-slot-name' }, [icon(slot.icon), el('span', { text: slot.label })]),
                el('div', { class: 'done-chips' }, chips),
                entry.headache ? el('span', { class: 'badge badge-critical' }, [icon('fa-bolt'), el('span', { text: 'Headache' })]) : null,
                entry.triptan ? el('span', { class: 'badge badge-serious' }, [icon('fa-pills'), el('span', { text: 'Triptan' })]) : null,
                el('button', {
                    type: 'button', class: 'link-btn',
                    onclick: () => editEntry(dayKey(), slot.key),
                }, [el('span', { text: 'Edit' })]),
            ]));
        }
        return summary;
    }

    // A span rather than a div: this sits inside the collapsed header button,
    // which may only contain phrasing content.
    function streakChip() {
        const days = WD.store.streak();
        return el('span', {
            class: `streak${days >= 3 ? ' hot' : ''}`,
            title: 'Consecutive days with at least one check-in',
        }, [
            icon(days >= 3 ? 'fa-fire' : 'fa-calendar-check'),
            el('b', { text: String(days) }),
            el('span', { text: days === 1 ? 'day' : 'days' }),
        ]);
    }

    // ------------------------------------------------------------- backfill
    /* What is missing and still worth filling in: today's slots whose window
     * has closed, then whole days with nothing at all. Holes are worse than
     * approximate entries — the lead/lag analysis needs contiguous days, and a
     * gap always lands on exactly the week that turned out to be interesting. */
    function missedSlots() {
        const today = dayKey();
        const m = minutesOfDay();
        const gaps = [];

        for (const slot of SLOTS) {
            if (m > slot.closesAt && !WD.store.get(today, slot.key)) {
                gaps.push({ day: today, slot: slot.key, label: `Today · ${slot.label.toLowerCase()}` });
            }
        }
        for (let i = 1; i <= BACKFILL_DAYS; i++) {
            const day = addDays(today, -i);
            if (!SLOTS.some(s => WD.store.get(day, s.key))) {
                gaps.push({ day, slot: 'evening', label: formatDayLabel(day) });
            }
        }
        return gaps;
    }

    function backfillRow(gaps) {
        return el('div', { class: 'backfill' }, [
            el('span', { class: 'backfill-label' }, [icon('fa-clock-rotate-left'), el('span', { text: 'Not logged yet' })]),
            ...gaps.map(gap => el('button', {
                type: 'button', class: 'chip',
                onclick: () => editEntry(gap.day, gap.slot),
            }, [el('span', { text: gap.label })])),
        ]);
    }

    // --------------------------------------------------------------- toasts
    function toast(message) {
        const node = el('div', { class: 'toast', role: 'status' }, [icon('fa-check'), el('span', { text: message })]);
        document.body.appendChild(node);
        requestAnimationFrame(() => node.classList.add('in'));
        setTimeout(() => {
            node.classList.remove('in');
            setTimeout(() => node.remove(), 300);
        }, 3200);
    }

    let changeHandler = () => {};
    const notifyChanged = () => changeHandler();

    function init(node, { onChange } = {}) {
        container = node;
        changeHandler = onChange || (() => {});

        // Digits typed anywhere in the card work, not only inside a rating
        // group — the point is that the run never needs a mouse.
        container.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.target.tagName === 'INPUT') return;
            const form = container.querySelector('.checkin-form');
            const save = form?.querySelector('.btn-save');
            if (form && save && !save.disabled && !e.target.closest('.checkin-actions')) {
                e.preventDefault();
                save.click();
            }
        });

        render();
    }

    const editEntry = (day, slot) => { editing = { day, slot }; render(); container.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

    return { init, render, gating, currentTarget, editEntry, onSaved, toast };
})();
