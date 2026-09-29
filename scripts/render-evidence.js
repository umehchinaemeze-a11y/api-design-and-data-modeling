'use strict';

/*
 * render-evidence.js
 * Renders every artifact in ./evidence into a high-resolution PNG.
 *
 *   *.mermaid  -> diagram PNG (mermaid rendered in headless Edge/Chrome)
 *   *.txt      -> terminal-style PNG of the captured PostgreSQL console output
 *
 * Rendering is fully local: the mermaid bundle is served from node_modules over
 * a short-lived loopback HTTP server (Chromium refuses ES-module imports from
 * file:// URLs), and no external network resource is ever requested.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const REPO_ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence');
const OUT_DIR = path.join(EVIDENCE_DIR, 'images');
const MERMAID_DIST = path.join(REPO_ROOT, 'node_modules', 'mermaid', 'dist');

const SCALE = 2;
const FONT_SIZE = 15;
const FONT_STACK = "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', 'Courier New', monospace";
const MAX_COLUMNS = 200;
const INDENT = '    ';

const CHROME_CANDIDATES = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
];

function findBrowser() {
    for (const candidate of CHROME_CANDIDATES) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    throw new Error('No Chromium-based browser found. Set PUPPETEER_EXECUTABLE_PATH to a Chrome or Edge binary.');
}

function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* Wraps a logical line to MAX_COLUMNS, preferring a word boundary and marking
 * continuations so a folded line is never mistaken for a separate record. */
function wrapLine(text, limit) {
    if (text.length <= limit) return [{ text, folded: false }];

    const out = [];
    let rest = text;
    let folded = false;

    while (rest.length > limit) {
        let cut = rest.lastIndexOf(' ', limit);
        if (cut <= limit * 0.6) cut = limit;
        out.push({ text: rest.slice(0, cut).replace(/\s+$/, ''), folded });
        rest = rest.slice(cut).replace(/^\s+/, '');
        folded = true;
    }
    out.push({ text: rest, folded });

    return out;
}

/* Line-level classification drives the block colour (headings, errors, verdicts). */
const LINE_RULES = [
    { kind: 'banner', re: /^\s*---\s/ },
    { kind: 'section', re: /^\s*(SQL|SQL ATTEMPTED|OUTPUT|DATABASE ENGINE RESPONSE|QUERY PLAN|Requirement|Target|STATUS|Verdict|PASS|FAIL|ERROR|Result|Dataset summary|Planning)\b\s*:/i },
    { kind: 'success', re: /^\s*(STATUS|Verdict)\b.*\b(SUCCESS|PASS|PASSED|OK)\b/i },
    { kind: 'failure', re: /^\s*(STATUS|Verdict)\b.*\b(FAIL|FAILED|ERROR)\b/i },
    { kind: 'error', re: /^\s*(Error Message|PostgreSQL SQLSTATE|ERROR|DETAIL|Detail|Constraint)\s*:/i },
    { kind: 'note', re: /^\s*(Note|NOTE|Target Index|Rider|Driver)\s*:/i }
];

function classifyLine(line) {
    for (const rule of LINE_RULES) {
        if (rule.re.test(line)) return rule.kind;
    }
    return '';
}

/* Single-pass tokenizer: matched spans are escaped individually, everything
 * that is not matched is escaped as plain text, so output is always safe. */
const TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\bnull\b|\bNULL\b|\btrue\b|\bfalse\b)/g;

function highlightLine(line) {
    let html = '';
    let cursor = 0;

    for (const m of line.matchAll(TOKEN_RE)) {
        html += escapeHtml(line.slice(cursor, m.index));
        cursor = m.index + m[0].length;

        if (m[1] !== undefined) {
            const isKey = m[2] !== undefined;
            html += `<span class="${isKey ? 't-key' : 't-str'}">${escapeHtml(m[1])}</span>`;
            if (m[2] !== undefined) html += escapeHtml(m[2]);
        } else if (m[3] !== undefined) {
            html += `<span class="t-str">${escapeHtml(m[3])}</span>`;
        } else if (m[4] !== undefined) {
            html += `<span class="t-num">${escapeHtml(m[4])}</span>`;
        } else if (m[5] !== undefined) {
            html += `<span class="t-null">${escapeHtml(m[5])}</span>`;
        }
    }

    html += escapeHtml(line.slice(cursor));
    return html || '&nbsp;';
}

function buildTextBody(source) {
    const lines = source.replace(/\r\n/g, '\n').replace(/\t/g, INDENT).split('\n');
    const rendered = [];

    for (const line of lines) {
        const kind = classifyLine(line);
        for (const piece of wrapLine(line, MAX_COLUMNS)) {
            const foldClass = piece.folded ? ' folded' : '';
            const kindClass = kind ? ` k-${kind}` : '';
            rendered.push(
                `<div class="line${kindClass}${foldClass}">${highlightLine(piece.text)}</div>`
            );
        }
    }

    return rendered.join('\n');
}

function baseCss() {
    return `
        *, *::before, *::after { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #ffffff; }
        body {
            font-family: ${FONT_STACK};
            font-variant-ligatures: none;
            -webkit-font-smoothing: antialiased;
        }
        .frame {
            display: inline-block;
            background: #ffffff;
            border: 1px solid #d0d7de;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(27, 31, 36, 0.10);
        }
        .chrome {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 9px 14px;
            background: #1f2429;
            color: #e6edf3;
            font-size: 12.5px;
            letter-spacing: 0.2px;
        }
        .dots { display: flex; gap: 6px; }
        .dot { width: 11px; height: 11px; border-radius: 50%; display: block; }
        .dot.r { background: #ff5f57; }
        .dot.y { background: #febc2e; }
        .dot.g { background: #28c840; }
        .chrome .path { opacity: 0.92; }
        .chrome .spacer { flex: 1 1 auto; }
        .chrome .stamp { opacity: 0.62; font-size: 11.5px; }
    `;
}

function textPage(source, title, stamp) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>${baseCss()}
    .body {
        padding: 16px 20px 18px;
        font-size: ${FONT_SIZE}px;
        line-height: 1.5;
        color: #1f2328;
    }
    .line { white-space: pre; min-height: 1.5em; }
    .line.folded { padding-left: 2ch; }
    .line.folded::before { content: '\\21B3  '; color: #8c959f; }
    .k-banner { color: #0550ae; font-weight: 700; }
    .k-section { color: #1a7f37; font-weight: 700; }
    .k-success { color: #1a7f37; font-weight: 700; }
    .k-failure { color: #cf222e; font-weight: 700; }
    .k-error { color: #cf222e; }
    .k-note { color: #6639ba; font-weight: 600; }
    .t-key { color: #0550ae; }
    .t-str { color: #0a3069; }
    .t-num { color: #953800; }
    .t-null { color: #8c959f; font-style: italic; }
</style>
</head>
<body>
<div class="frame" id="frame">
    <div class="chrome">
        <span class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></span>
        <span class="path">${escapeHtml(title)}</span>
        <span class="spacer"></span>
        <span class="stamp">${escapeHtml(stamp)}</span>
    </div>
    <div class="body">${buildTextBody(source)}</div>
</div>
</body>
</html>`;
}

function diagramPage(title, stamp) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>${baseCss()}
    .diagram { padding: 20px 24px 24px; background: #ffffff; }
    #host { display: inline-block; }
    #host svg { display: block; height: auto; }
    .legend {
        padding: 0 24px 18px;
        font-size: 12.5px;
        color: #57606a;
    }
</style>
</head>
<body>
<div class="frame" id="frame">
    <div class="chrome">
        <span class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></span>
        <span class="path">${escapeHtml(title)}</span>
        <span class="spacer"></span>
        <span class="stamp">${escapeHtml(stamp)}</span>
    </div>
    <div class="diagram"><div id="host"></div></div>
    <div class="legend">UrbanGlide architectural proof &middot; source: <code>${escapeHtml(title)}</code></div>
</div>
<script type="module">
    import mermaid from '/mermaid/dist/mermaid.esm.min.mjs';

    const source = await (await fetch('/diagram-source')).text();

    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis', nodeSpacing: 45, rankSpacing: 55 },
        er: { useMaxWidth: false, layoutDirection: 'TB' },
        state: { useMaxWidth: false },
        themeVariables: {
            fontSize: '17px',
            primaryColor: '#eef2f6',
            primaryTextColor: '#1f2328',
            primaryBorderColor: '#4a5560',
            lineColor: '#4a5560',
            secondaryColor: '#f4f6f8',
            tertiaryColor: '#fbfcfd',
            background: '#ffffff',
            mainBkg: '#eef2f6',
            nodeBorder: '#4a5560',
            clusterBkg: '#fbfcfd',
            clusterBorder: '#9aa4ae',
            edgeLabelBackground: '#ffffff',
            titleColor: '#1f2328',
            noteBkgColor: '#fff8c5',
            noteTextColor: '#1f2328',
            noteBorderColor: '#d4a72c',
            actorBkg: '#eef2f6',
            actorBorder: '#4a5560',
            actorTextColor: '#1f2328',
            labelBoxBkgColor: '#eef2f6',
            labelBoxBorderColor: '#4a5560',
            labelTextColor: '#1f2328',
            loopTextColor: '#1f2328'
        }
    });

    const { svg } = await mermaid.render('diagram', source);
    document.getElementById('host').innerHTML = svg;

    /* mermaid emits width="100%" plus a max-width cap. Inside a shrink-to-fit
     * frame that collapses to zero, so pin the diagram to its viewBox size. */
    const svgNode = document.querySelector('#host svg');
    const viewBox = svgNode.viewBox && svgNode.viewBox.baseVal;
    const box = svgNode.getBBox();
    const width = Math.ceil(viewBox && viewBox.width ? viewBox.width : box.width);
    const height = Math.ceil(viewBox && viewBox.height ? viewBox.height : box.height);

    svgNode.removeAttribute('style');
    svgNode.setAttribute('width', String(width));
    svgNode.setAttribute('height', String(height));
    window.__renderState = 'ok';
</script>
</body>
</html>`;
}

function startServer(diagramSource) {
    const pages = new Map();

    const server = http.createServer((req, res) => {
        const url = req.url.split('?')[0];

        if (url === '/diagram-source') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(diagramSource);
        }

        if (url.startsWith('/mermaid/dist/')) {
            const target = path.join(MERMAID_DIST, url.slice('/mermaid/dist/'.length));
            if (!target.startsWith(MERMAID_DIST) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
                res.writeHead(404);
                return res.end('not found');
            }
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            return res.end(fs.readFileSync(target));
        }

        if (pages.has(url)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(pages.get(url));
        }

        res.writeHead(404);
        res.end('not found');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, pages });
        });
    });
}

/* Extracts the labels a reader is meant to see, ignoring Mermaid's structural
 * keywords (flowchart, subgraph, end, state names, edge target ids, ...). */
function expectedLabels(source) {
    const labels = new Set();

    for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        for (const word of match[1].match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []) labels.add(word);
    }

    /* Attribute / note blocks only: an opening "{" alone on its line through a
     * closing "}" alone on its line. A lazy \{[^}]*\} would otherwise swallow
     * the cardinality braces in ER relationship lines. */
    for (const match of source.matchAll(/^[ \t]*\{([\s\S]*?)^[ \t]*\}/gm)) {
        for (const line of match[1].split('\n')) {
            const [field, ...rest] = line.trim().split(/\s+/);
            if (field) labels.add(field);
            labels.add(rest.join(' '));
        }
    }

    for (const match of source.matchAll(/:\s*([^:|\n]+)/g)) {
        for (const word of match[1].match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []) labels.add(word);
    }

    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('-') && /[A-Za-z]{3,}/.test(trimmed)) labels.add(trimmed);
    }

    for (const label of [...labels]) {
        for (const word of label.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []) labels.add(word);
    }

    labels.delete('');
    return [...labels].filter((word) => word.length <= 40 && !/[{}\[\]|<>()"'`]/.test(word));
}

/* Guards the "clear PNG" claim without a human in the loop: no clipped text,
 * no text outside the diagram canvas, and no source label silently dropped. */
async function auditPage(page, source, isDiagram) {
    const problems = [];

    if (isDiagram) {
        const report = await page.evaluate(() => {
            const svg = document.querySelector('#host svg');
            const vb = svg.viewBox.baseVal;
            const text = svg.textContent.replace(/\s+/g, ' ');
            const labelled = [...svg.querySelectorAll('text, foreignObject')];
            const canvas = svg.getBoundingClientRect();
            let overflowing = 0;

            /* Screen-space rects: getBBox() is local to a node's own transform,
             * so it cannot be compared against the root viewBox. */
            for (const node of labelled) {
                const box = node.getBoundingClientRect();
                if (box.width === 0 && box.height === 0) continue;
                if (box.left < canvas.left - 1 || box.right > canvas.right + 1) overflowing += 1;
            }

            return {
                text,
                overflowing,
                labelled: labelled.length,
                vbWidth: vb.width,
                vbHeight: vb.height
            };
        });

        const missing = expectedLabels(source).filter((word) => !report.text.includes(word));

        if (report.labelled === 0) problems.push('diagram rendered no labels');
        if (report.overflowing > 0) problems.push(`${report.overflowing} label(s) overflow the diagram canvas`);
        if (missing.length) problems.push(`labels missing from render: ${missing.slice(0, 6).join(', ')}`);

        return { problems, note: `(${report.labelled} labels, canvas ${Math.round(report.vbWidth)}x${Math.round(report.vbHeight)})` };
    }

    const report = await page.evaluate(() => {
        const body = document.querySelector('.body');
        const lines = [...document.querySelectorAll('.line')];
        const clipped = lines.filter((line) => line.scrollWidth > line.clientWidth + 1).length;
        return {
            clipped,
            lineCount: lines.length,
            bodyWidth: body.getBoundingClientRect().width,
            widest: Math.max(...lines.map((line) => line.scrollWidth))
        };
    });

    const expected = source.replace(/\r\n/g, '\n').replace(/\t/g, INDENT).split('\n')
        .reduce((total, line) => total + wrapLine(line, MAX_COLUMNS).length, 0);

    if (report.lineCount !== expected) problems.push(`rendered ${report.lineCount} lines, expected ${expected}`);
    if (report.clipped > 0) problems.push(`${report.clipped} line(s) are clipped`);
    if (report.widest > report.bodyWidth + 1) problems.push('text wider than the frame');

    return { problems, note: `(${report.lineCount} lines, ${Math.round(report.widest)}px text width)` };
}

async function main() {
    const executablePath = findBrowser();
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const files = fs.readdirSync(EVIDENCE_DIR)
        .filter((name) => /\.(txt|mermaid)$/i.test(name))
        .sort();

    if (files.length === 0) {
        throw new Error('No .txt or .mermaid files found in the evidence directory.');
    }

    const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--hide-scrollbars',
            '--force-color-profile=srgb',
            '--disable-lcd-text',
            '--font-render-hinting=none'
        ]
    });

    const written = [];

    try {
        for (const name of files) {
            const source = fs.readFileSync(path.join(EVIDENCE_DIR, name), 'utf8');
            const isDiagram = /\.mermaid$/i.test(name);
            const title = `evidence/${name}`;
            const stamp = isDiagram
                ? 'Rendered from Mermaid source'
                : 'Captured from PostgreSQL 16';

            const { server, port, pages } = await startServer(isDiagram ? source : '');

            try {
                const page = await browser.newPage();
                await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: SCALE });
                page.on('pageerror', (err) => console.error(`  ! page error: ${err.message}`));

                const route = `/${encodeURIComponent(name)}`;
                pages.set(route, isDiagram ? diagramPage(title, stamp) : textPage(source, title, stamp));

                await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle0', timeout: 60000 });

                if (isDiagram) {
                    await page.waitForFunction('window.__renderState === "ok"', { timeout: 60000 });
                }
                await page.evaluate(() => document.fonts.ready);

                const audit = await auditPage(page, source, isDiagram);
                if (audit.problems.length) {
                    throw new Error(`${name}: ${audit.problems.join('; ')}`);
                }

                const frame = await page.$('#frame');
                const outPath = path.join(OUT_DIR, `${path.basename(name, path.extname(name))}.png`);
                await frame.screenshot({ path: outPath });

                const { width, height } = await frame.boundingBox();
                const size = fs.statSync(outPath).size;
                written.push({ name, outPath, width, height, size });

                console.log(
                    `  ok  ${name.padEnd(26)} -> images/${path.basename(outPath)}  ` +
                    `${Math.round(width)}x${Math.round(height)} css  ${(size / 1024).toFixed(1)} KB  ${audit.note}`
                );

                await page.close();
            } finally {
                server.close();
            }
        }
    } finally {
        await browser.close();
    }

    const manifest = written.map((item) => ({
        source: `evidence/${item.name}`,
        image: `evidence/images/${path.basename(item.outPath)}`,
        width: Math.round(item.width * SCALE),
        height: Math.round(item.height * SCALE)
    }));

    fs.writeFileSync(
        path.join(OUT_DIR, 'manifest.json'),
        JSON.stringify({ generatedBy: 'scripts/render-evidence.js', scale: SCALE, images: manifest }, null, 4) + '\n'
    );

    console.log(`\nRendered ${written.length} image(s) into evidence/images at ${SCALE}x scale.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
