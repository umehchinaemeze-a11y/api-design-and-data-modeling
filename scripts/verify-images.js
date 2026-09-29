'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT_LOCAL = path.join(__dirname, '..');
const IMAGES_DIR = path.join(REPO_ROOT_LOCAL, 'evidence', 'images');

function readPng(file) {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');

    let offset = 8;
    const chunks = [];
    let ihdr = null;

    while (offset < buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);
        const data = buf.slice(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            ihdr = {
                width: data.readUInt32BE(0),
                height: data.readUInt32BE(4),
                bitDepth: data[8],
                colorType: data[9],
                interlace: data[12]
            };
        } else if (type === 'IDAT') {
            chunks.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length;
    }

    const raw = zlib.inflateSync(Buffer.concat(chunks));
    const bytesPerPixel = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];

    return { ihdr, raw, bytesPerPixel };
}

/* Counts pixels that differ from the modal background colour, as a cheap
 * "is there actually content here" signal, and detects fully blank output. */
function analyse(file) {
    const { ihdr, raw, bytesPerPixel } = readPng(file);
    const stride = ihdr.width * bytesPerPixel;
    const filterUnit = stride + 1;
    const prior = Buffer.alloc(stride);
    const current = Buffer.alloc(stride);
    const unfiltered = Buffer.alloc(ihdr.height * stride);

    for (let y = 0; y < ihdr.height; y += 1) {
        const base = y * filterUnit;
        const filter = raw[base];
        raw.copy(current, 0, base + 1, base + 1 + stride);

        for (let i = 0; i < stride; i += 1) {
            const a = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
            const b = prior[i];
            const c = i >= bytesPerPixel ? prior[i - bytesPerPixel] : 0;
            let value = current[i];
            if (filter === 1) value += a;
            else if (filter === 2) value += b;
            else if (filter === 3) value += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            current[i] = value & 0xff;
        }

        current.copy(unfiltered, y * stride);
        current.copy(prior);
    }

    const tally = new Map();
    for (let i = 0; i < unfiltered.length; i += bytesPerPixel) {
        const key = unfiltered.readUIntBE(i, bytesPerPixel);
        tally.set(key, (tally.get(key) || 0) + 1);
    }

    let background = 0;
    let backgroundKey = -1;
    for (const [key, count] of tally) {
        if (count > background) { background = count; backgroundKey = key; }
    }

    let ink = 0;
    for (let i = 0; i < unfiltered.length; i += bytesPerPixel) {
        if (unfiltered.readUIntBE(i, bytesPerPixel) !== backgroundKey) ink += 1;
    }

    const total = ihdr.width * ihdr.height;

    return {
        width: ihdr.width,
        height: ihdr.height,
        bitDepth: ihdr.bitDepth,
        colorType: ihdr.colorType,
        bytes: fs.statSync(file).size,
        inkRatio: ink / total,
        distinctColors: tally.size
    };
}

const manifest = JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, 'manifest.json'), 'utf8'));
let failed = false;

console.log('file'.padEnd(28) + 'pixels'.padEnd(14) + 'ink%'.padEnd(9) + 'colors'.padEnd(9) + 'KB'.padEnd(8) + 'status');
console.log('-'.repeat(78));

for (const entry of manifest.images) {
    const file = path.join(REPO_ROOT_LOCAL, entry.image);
    const stats = analyse(file);
    const problems = [];

    if (stats.width < 200 || stats.height < 100) problems.push('too small');
    if (stats.inkRatio < 0.01) problems.push('looks blank');
    if (stats.inkRatio > 0.985) problems.push('looks solid');
    if (stats.bitDepth !== 8) problems.push('bit depth ' + stats.bitDepth);
    if (stats.width * 2 > 12000) problems.push('excessively wide');

    const status = problems.length ? 'FAIL: ' + problems.join(', ') : 'ok';
    if (problems.length) failed = true;

    console.log(
        path.basename(entry.image).padEnd(28) +
        `${stats.width}x${stats.height}`.padEnd(14) +
        (stats.inkRatio * 100).toFixed(1).padEnd(9) +
        String(stats.distinctColors).padEnd(9) +
        (stats.bytes / 1024).toFixed(1).padEnd(8) +
        status
    );
}

console.log(failed ? '\nSome images failed validation.' : '\nAll images passed validation.');
process.exit(failed ? 1 : 0);
