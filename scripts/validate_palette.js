#!/usr/bin/env node
/* Palette validator for CFG.COLOR.
 *
 *   node scripts/validate_palette.js
 *
 * CLAUDE.md says every colour in the palette has been through a contrast/CVD
 * validator before landing, and to re-run it rather than hand-editing a hex.
 * This is that validator.
 *
 * What it checks:
 *
 *   environment hues  all-pairs perceptual distance (CIEDE2000), under normal
 *                     vision and under simulated protanopia, deuteranopia and
 *                     tritanopia. These four are allowed a lower bar than a
 *                     colour-only encoding would need, because every measure
 *                     also carries an icon and a text label — hue is a
 *                     redundant cue here, not the sole one.
 *
 *   severity ramp     ordinal checks: lightness strictly increasing, each step
 *                     at least dL 0.06 clear of the last, and the light end
 *                     readable against the surface. Level 0 is deliberately
 *                     absent from the ramp (it renders as an empty cell).
 *
 *   severity ink      the digit drawn on each ramp step, >= 4.5:1 on it.
 *
 *   status colours    good -> critical, >= 3:1 on the surface. These always
 *                     ship with an icon and a label, so they are non-text
 *                     graphical objects by WCAG's reckoning.
 *
 * CVD simulation uses the Machado, Oliveira & Fernandes (2009) matrices at
 * severity 1.0, applied in linear RGB.
 */

'use strict';

const SURFACE = '#1a1a19';

// ------------------------------------------------------------------ colour
const hexToRgb = (hex) => {
    const h = hex.replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
};

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const linearize = (rgb) => rgb.map(toLinear);

/* Relative luminance, per WCAG 2.x. */
const luminance = (rgb) => {
    const [r, g, b] = linearize(rgb);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
    const la = luminance(hexToRgb(a));
    const lb = luminance(hexToRgb(b));
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
};

// ------------------------------------------------------------------- CIELab
const D65 = [0.95047, 1.0, 1.08883];

function rgbToXyz(rgb) {
    const [r, g, b] = linearize(rgb);
    return [
        r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
        r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
        r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
    ];
}

function xyzToLab(xyz) {
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
    const [fx, fy, fz] = xyz.map((v, i) => f(v / D65[i]));
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rgbToLab = (rgb) => xyzToLab(rgbToXyz(rgb));

/* CIEDE2000. Sharma, Wu & Dalal (2005) formulation. */
function deltaE(lab1, lab2) {
    const [L1, a1, b1] = lab1;
    const [L2, a2, b2] = lab2;
    const rad = Math.PI / 180;

    const C1 = Math.hypot(a1, b1);
    const C2 = Math.hypot(a2, b2);
    const Cbar = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));

    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1);
    const C2p = Math.hypot(a2p, b2);

    const hp = (b, ap) => {
        if (b === 0 && ap === 0) return 0;
        const h = Math.atan2(b, ap) / rad;
        return h < 0 ? h + 360 : h;
    };
    const h1p = hp(b1, a1p);
    const h2p = hp(b2, a2p);

    const dLp = L2 - L1;
    const dCp = C2p - C1p;

    let dhp;
    if (C1p * C2p === 0) dhp = 0;
    else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
    else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
    else dhp = h2p - h1p + 360;
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);

    const Lbarp = (L1 + L2) / 2;
    const Cbarp = (C1p + C2p) / 2;

    let hbarp;
    if (C1p * C2p === 0) hbarp = h1p + h2p;
    else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;

    const T = 1
        - 0.17 * Math.cos((hbarp - 30) * rad)
        + 0.24 * Math.cos(2 * hbarp * rad)
        + 0.32 * Math.cos((3 * hbarp + 6) * rad)
        - 0.20 * Math.cos((4 * hbarp - 63) * rad);

    const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
    const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
    const Sc = 1 + 0.045 * Cbarp;
    const Sh = 1 + 0.015 * Cbarp * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;

    return Math.sqrt(
        (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
        + Rt * (dCp / Sc) * (dHp / Sh),
    );
}

// --------------------------------------------------------------------- CVD
// Machado, Oliveira & Fernandes (2009), severity 1.0, linear RGB.
const CVD = {
    normal: null,
    protan: [
        [0.152286, 1.052583, -0.204868],
        [0.114503, 0.786281, 0.099216],
        [-0.003882, -0.048116, 1.051998],
    ],
    deutan: [
        [0.367322, 0.860646, -0.227968],
        [0.280085, 0.672501, 0.047413],
        [-0.011820, 0.042940, 0.968881],
    ],
    tritan: [
        [1.255528, -0.076749, -0.178779],
        [-0.078411, 0.930809, 0.147602],
        [0.004733, 0.691367, 0.303900],
    ],
};

function simulate(hex, kind) {
    const rgb = hexToRgb(hex);
    const m = CVD[kind];
    if (!m) return rgb;
    const lin = linearize(rgb);
    return m
        .map(row => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])
        .map(v => toSrgb(Math.min(1, Math.max(0, v))));
}

// ------------------------------------------------------------------ report
let failures = 0;
const pass = (ok, msg) => {
    if (!ok) failures++;
    console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${msg}`);
};

// Parse CFG.COLOR straight out of the config so the two cannot drift apart.
function loadPalette() {
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
    /* config.js is a browser script: it assigns window.WD.CFG and then refers
     * to WD unqualified. Making the sandbox its own `window` satisfies both. */
    const sandbox = vm.createContext({});
    sandbox.window = sandbox;
    vm.runInContext(src, sandbox);
    return sandbox.WD.CFG.COLOR;
}

const COLOR = loadPalette();

const ENV = {
    temperature: COLOR.temperature,
    humidity: COLOR.humidity,
    pressure: COLOR.pressure,
    co2: COLOR.co2,
};

// The four environment hues each also carry an icon and a text label, so hue
// is a redundant cue. 5.0 is the floor for "tellable apart at a glance when
// they are adjacent lines on the same chart"; below that they read as one.
const ENV_MIN_DE = 5.0;
const ENV_MIN_CONTRAST = 3.0;

console.log('\nEnvironment hues');
for (const [k, v] of Object.entries(ENV)) {
    const c = contrast(v, SURFACE);
    pass(c >= ENV_MIN_CONTRAST,
        `${k.padEnd(12)} ${v}  ${c.toFixed(2)}:1 on ${SURFACE} (need ${ENV_MIN_CONTRAST})`);
}

console.log('\nEnvironment hues — all-pairs separation');
const keys = Object.keys(ENV);
let worst = { de: Infinity };
for (const kind of ['normal', 'protan', 'deutan', 'tritan']) {
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            const de = deltaE(
                rgbToLab(simulate(ENV[keys[i]], kind)),
                rgbToLab(simulate(ENV[keys[j]], kind)));
            if (de < worst.de) worst = { de, kind, a: keys[i], b: keys[j] };
            pass(de >= ENV_MIN_DE,
                `${kind.padEnd(7)} ${keys[i]}/${keys[j]}`.padEnd(34)
                + `dE ${de.toFixed(1)} (need ${ENV_MIN_DE})`);
        }
    }
}
console.log(`\n  worst pair: ${worst.a}/${worst.b} under ${worst.kind}, dE ${worst.de.toFixed(1)}`);

console.log('\nSeverity ramp (ordinal)');
const ramp = COLOR.severity.slice(1);
const Ls = ramp.map(h => rgbToLab(hexToRgb(h))[0] / 100);
for (let i = 1; i < Ls.length; i++) {
    pass(Ls[i] > Ls[i - 1], `L increases at step ${i} (${Ls[i - 1].toFixed(3)} -> ${Ls[i].toFixed(3)})`);
    pass(Ls[i] - Ls[i - 1] >= 0.06, `dL >= 0.06 at step ${i} (${(Ls[i] - Ls[i - 1]).toFixed(3)})`);
}
const lowC = contrast(ramp[0], SURFACE);
pass(lowC >= 3.0, `low step ${ramp[0]} is ${lowC.toFixed(2)}:1 on surface — distinct from an empty cell`);
const highC = contrast(ramp[ramp.length - 1], SURFACE);
pass(highC >= 2.15, `light end ${ramp[ramp.length - 1]} is ${highC.toFixed(2)}:1 on surface`);

console.log('\nSeverity ink on its step');
COLOR.severityInk.forEach((ink, i) => {
    if (!ink) return;
    const c = contrast(ink, COLOR.severity[i]);
    pass(c >= 4.5, `level ${i}: ${ink} on ${COLOR.severity[i]} = ${c.toFixed(2)}:1`);
});

console.log('\nStatus colours on surface');
for (const [k, v] of Object.entries(COLOR.status)) {
    const c = contrast(v, SURFACE);
    pass(c >= 3.0, `${k.padEnd(9)} ${v}  ${c.toFixed(2)}:1`);
}

console.log(`\n${failures ? `\x1b[31m${failures} check(s) failed\x1b[0m` : '\x1b[32mAll checks passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
