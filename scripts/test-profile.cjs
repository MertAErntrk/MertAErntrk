const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'previews/v13');
const resultDir = path.join(root, 'test-results');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(resultDir, { recursive: true });
const report = { checkedAt: new Date().toISOString(), revision: 'slower-synchronized-scan-v13', structure: [], animation: [], responsive: [], cycles: [], limitations: ['Local Chrome only. GitHub-hosted rendering is verified separately after publication.', 'GitHub uses native table borders and two columns for the README cards; the local HTML preview uses responsive CSS cards.', 'The motion toggle is available in the local HTML preview, not inside GitHub image embeds.'] };
const geometry = mobile => mobile ? { width: 320, height: 462, x: 64, y: 64, size: 192 } : { width: 960, height: 352, x: 32, y: 76, size: 224 };
const buffers = new Map();
const silhouetteBuffers = new Map();

async function raw(image, rect) {
  const pipeline = sharp(image);
  if (rect) pipeline.extract(rect);
  return pipeline.removeAlpha().raw().toBuffer();
}
function delta(a, b) {
  assert.equal(a.length, b.length);
  let maximum = 0;
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  return maximum;
}
async function solid(image, rect, color, label) {
  const data = await raw(image, rect);
  let errors = 0;
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] - color[i % 3]) > 1) errors++;
  assert.equal(errors, 0, label);
}
async function silhouettePortrait(image, baseline, g) {
  const rect = { left: g.x + 12, top: g.y + 12, width: g.size - 24, height: g.size - 24 };
  assert.equal(delta(await raw(image, rect), await raw(baseline, rect)), 0, 'Only the faint silhouette may remain after erasing');
}
async function faintSilhouette(image, g, theme) {
  const rect = { left: g.x + 12, top: g.y + 12, width: g.size - 24, height: g.size - 24 };
  const pixels = await raw(image, rect);
  const background = theme === 'dark' ? [17, 24, 32] : [234, 240, 244];
  let changedPixels = 0, maximum = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const difference = Math.max(...[0, 1, 2].map(channel => Math.abs(pixels[i + channel] - background[channel])));
    maximum = Math.max(maximum, difference);
    if (difference > 1) changedPixels++;
  }
  assert(changedPixels > 100, 'A faint silhouette must remain visible');
  assert(maximum <= 6, 'The silhouette must remain barely visible, not a second full photo');
  return { changedPixels, maximumChannelDifference: maximum };
}
async function portraitPart(image, reference, g, part) {
  const rect = { left: g.x + 12, top: g.y + (part === 'top' ? 12 : Math.floor(g.size * .75)), width: g.size - 24, height: Math.floor(g.size * .25) - 12 };
  assert.equal(delta(await raw(image, rect), await raw(reference, rect)), 0, 'Scan coverage must match the stationary ' + part + ' reference');
}
const infoAreas = mobile => (mobile ? [[277, 36], [320, 36], [372, 26], [398, 26], [431, 21]] :
  [[78, 50], [140, 36], [201, 30], [229, 30], [312, 23]])
  .map(([top, height]) => ({ left: mobile ? 20 : 300, top, width: mobile ? 280 : 628, height }));
const background = theme => theme === 'dark' ? [11, 15, 20] : [248, 250, 252];
async function emptyInfo(image, mobile, theme) {
  for (const area of infoAreas(mobile)) await solid(image, area, background(theme), 'Erased information must not leave text or a cursor');
}
async function infoPixels(image, mobile, theme) {
  const color = background(theme);
  const counts = [];
  for (const area of infoAreas(mobile)) {
    const pixels = await raw(image, area);
    let count = 0;
    for (let i = 0; i < pixels.length; i += 3) if ([0, 1, 2].some(channel => Math.abs(pixels[i + channel] - color[channel]) > 1)) count++;
    counts.push(count);
  }
  return counts;
}
async function frame(page, source, g, seconds, { reduced = false, fallback = false, hideScan = false, silhouetteOnly = false } = {}) {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const src = await page.evaluate(({ source, seconds, fallback, hideScan, silhouetteOnly }) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = fallback ? '.motion{animation:none!important;transform:none!important}.scan-line,.type-cursor{display:none!important}' :
      '.motion{animation-play-state:paused!important;animation-delay:-' + seconds + 's!important}';
    if (hideScan) style.textContent += '.scan-line{display:none!important}';
    if (silhouetteOnly) style.textContent += '.portrait-image,.scan-line{display:none!important}';
    doc.documentElement.appendChild(style);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(doc));
  }, { source, seconds, fallback, hideScan, silhouetteOnly });
  await page.setViewportSize({ width: g.width, height: g.height });
  await page.goto('about:blank');
  await page.setContent('<html><head><meta name="color-scheme" content="light dark"></head><body style="margin:0"><img alt="Profile test" style="display:block"></body></html>');
  await page.locator('img').evaluate((img, src) => new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = src; }), src + (reduced ? '#still' : ''));
  return page.screenshot();
}
async function portraitAlpha(page, source, size) {
  return page.evaluate(async ({ source, size }) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const image = new Image();
    image.src = doc.querySelector('#portrait').getAttribute('href');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, size, size);
    const pixels = context.getImageData(0, 0, size, size).data;
    return Array.from({ length: size * size }, (_, index) => pixels[index * 4 + 3]);
  }, { source, size });
}
async function scanCoverage(page, source, g, seconds, alpha) {
  const visible = await frame(page, source, g, seconds);
  const hidden = await frame(page, source, g, seconds, { hideScan: true });
  const area = { left: g.x, top: g.y, width: g.size, height: g.size };
  const a = await raw(visible, area), b = await raw(hidden, area);
  let changedPixels = 0;
  const rows = new Set();
  for (let i = 0; i < alpha.length; i++) {
    if (Math.max(...[0, 1, 2].map(channel => Math.abs(a[i * 3 + channel] - b[i * 3 + channel]))) <= 1) continue;
    assert(alpha[i] > 0, 'Scan must not cross transparent pixels at ' + seconds + 's: ' + (i % g.size) + ',' + Math.floor(i / g.size));
    changedPixels++;
    rows.add(Math.floor(i / g.size));
  }
  assert(changedPixels > 20, 'Scan must remain visible within the portrait');
  assert(rows.size >= 4 && rows.size <= 5, 'The thicker scan must cover four pixels, plus at most one antialiased row');
  return { seconds, changedPixels, visibleRows: rows.size, pixelsOutsideSilhouette: 0 };
}
async function positions(page, seconds) {
  return page.evaluate(seconds => {
    document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = seconds * 1000; });
    const matrix = selector => {
      const transform = getComputedStyle(document.querySelector(selector)).transform;
      const m = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
      return { x: m.e, y: m.f, scaleX: m.a, scaleY: m.d };
    };
    return {
      mask: matrix('.portrait-window'),
      scanner: matrix('.scan-line'),
      caret: matrix('.cursor-travel'),
      roleWidth: Number(document.querySelector('.role').getAttribute('textLength')),
      characters: document.querySelector('.role').textContent.length,
      imageTransform: getComputedStyle(document.querySelector('.portrait-image')).transform,
      imageOpacity: getComputedStyle(document.querySelector('.portrait-image')).opacity,
      silhouetteOpacity: getComputedStyle(document.querySelector('.portrait-silhouette')).opacity,
      silhouetteTransform: getComputedStyle(document.querySelector('.portrait-silhouette')).transform,
      silhouetteAnimations: document.querySelector('.portrait-silhouette').getAnimations().length,
      information: ['name', 'role', 'summary-1', 'summary-2', 'meta'].map(id => {
        const line = document.querySelector('#info-' + id + ' .typed-line');
        const glyphs = [...line.querySelectorAll('.typed-char')];
        const visible = glyphs.map(glyph => getComputedStyle(glyph).visibility === 'visible');
        return {
          id, text: line.textContent, count: glyphs.length, visible,
          visibleText: glyphs.filter((_, index) => visible[index]).map(glyph => glyph.textContent).join(''),
          visibleCount: visible.filter(Boolean).length,
          animations: glyphs.reduce((count, glyph) => count + glyph.getAnimations().length, 0),
          stationary: glyphs.every(glyph => getComputedStyle(glyph).transform === 'none'),
          renderedCharacters: line.getNumberOfChars(),
          characterPositions: Array.from({ length: line.getNumberOfChars() }, (_, index) => {
            const point = line.getStartPositionOfChar(index);
            return [point.x, point.y];
          }),
        };
      }),
    };
  }, seconds);
}

(async () => {
  let browser;
  try {
    const content = JSON.parse(fs.readFileSync(path.join(root, 'profile-content.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert(!/## Toolkit|Solution Architect|solution architecture/i.test(readme));
    assert(!/at the intersection|intelligent applications|coherent platform|agentic systems/i.test(readme));
    assert(!/\bPython\b|\bSQL\b/.test(readme));
    for (const title of [...content.roles, ...content.capabilities.map(item => item.title), ...content.focus.map(item => item.title)]) assert(readme.includes(title) || readme.includes(title.replaceAll('&', '&amp;')), 'README missing ' + title);
    assert(content.capabilities.length === 7 && content.focus.length === 3);
    for (const project of content.projects) assert(readme.includes('[' + project.title + '](' + project.url + ')'), 'Preserve existing project links');

    browser = await chromium.launch({ headless: true, ...(process.env.PROFILE_TEST_CHANNEL ? { channel: process.env.PROFILE_TEST_CHANNEL } : {}) });
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const readmeCards = await page.evaluate(source => {
      const doc = new DOMParser().parseFromString(source, 'text/html');
      const table = doc.querySelector('table');
      return {
        rows: table.rows.length,
        columns: [...table.rows].map(row => [...row.cells].reduce((count, cell) => count + cell.colSpan, 0)),
        cards: [...table.querySelectorAll('td')].map(cell => ({ title: cell.querySelector('strong').textContent.replace(/^\u2022 /, ''), description: cell.querySelector('p:last-child').textContent })),
        headings: table.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        links: table.querySelectorAll('a').length,
        markers: [...table.querySelectorAll('strong')].every(label => label.textContent.startsWith('\u2022 ')),
        customStyles: table.querySelectorAll('[style],style,script').length,
        lastCardSpan: table.rows[table.rows.length - 1].cells[0].colSpan,
      };
    }, readme);
    assert.deepEqual(readmeCards.cards, content.capabilities);
    assert.equal(readmeCards.rows, 4);
    assert.deepEqual(readmeCards.columns, [2, 2, 2, 2]);
    assert.equal(readmeCards.lastCardSpan, 2);
    assert.equal(readmeCards.customStyles, 0, 'README cards must not depend on custom CSS or scripts');
    assert.equal(readmeCards.headings, 0, 'Card labels must not generate GitHub heading permalinks');
    assert.equal(readmeCards.links, 0, 'Card labels must not contain protruding link icons');
    assert.equal(readmeCards.markers, true, 'Each card label uses an ordinary bullet');
    report.readmeCards = readmeCards;
    const sources = {};
    for (const theme of ['dark', 'light']) for (const mobile of [false, true]) {
      const name = theme + (mobile ? '-mobile' : '');
      const g = geometry(mobile);
      const source = fs.readFileSync(path.join(root, name + '.svg'), 'utf8');
      sources[name] = source;
      await page.setViewportSize({ width: g.width, height: g.height });
      await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: theme });
      await page.goto(pathToFileURL(path.join(root, name + '.svg')).href);
      await positions(page, 3.5);
      const structure = await page.evaluate(source => {
        const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
        const refs = ['clip-path', 'mask'].flatMap(attribute => [...doc.querySelectorAll('[' + attribute + ']')].map(el => el.getAttribute(attribute).slice(5, -1)));
        return {
          parserErrors: doc.querySelectorAll('parsererror').length,
          images: doc.querySelectorAll('image').length,
          uses: doc.querySelectorAll('use').length,
          alphaMask: document.querySelector('#portrait-alpha') ? getComputedStyle(document.querySelector('#portrait-alpha')).maskType : null,
          alphaSource: doc.querySelector('#portrait-alpha use')?.getAttribute('href'),
          scannerMask: doc.querySelector('.scan-line')?.parentElement.getAttribute('mask'),
          scannerHeight: Number(doc.querySelector('.scan-line')?.getAttribute('height')),
          opacityOwners: [...doc.querySelectorAll('[opacity]')].map(el => el.getAttribute('class')),
          animatedOpacity: document.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => 'opacity' in frame)),
          missingReferences: refs.filter(id => !doc.getElementById(id)),
          externalResources: [...doc.querySelectorAll('[href]')].map(el => el.getAttribute('href')).filter(href => !href.startsWith('#') && !href.startsWith('data:')),
          scripts: doc.querySelectorAll('script,foreignObject').length,
          typedCharacters: doc.querySelectorAll('.typed-char').length,
          clippedInformation: [...doc.querySelectorAll('.typed-line')].some(line => line.closest('[clip-path],[mask]')),
          durations: document.getAnimations().map(a => a.effect.getTiming().duration),
          portraitPhaseMs: document.querySelector('.portrait-window').getAnimations()[0].effect.getKeyframes().map(frame => frame.computedOffset * 10800),
          textBounds: [...document.querySelectorAll('text')].map(el => {
            const b = el.getBBox();
            const m = el.getCTM();
            const point = new DOMPoint(b.x, b.y).matrixTransform(m);
            return { text: el.textContent, x: point.x, y: point.y, width: b.width, height: b.height, fontSize: Number.parseFloat(getComputedStyle(el).fontSize), mono: el.classList.contains('mono') };
          }),
        };
      }, source);
      assert.equal(structure.parserErrors, 0);
      assert.equal(structure.images, 1);
      assert.equal(structure.uses, 3);
      assert.equal(structure.alphaMask, 'alpha');
      assert.equal(structure.alphaSource, '#portrait');
      assert.equal(structure.scannerMask, 'url(#portrait-alpha)');
      assert.equal(structure.scannerHeight, 4);
      assert.deepEqual(structure.opacityOwners, ['portrait-silhouette']);
      assert.equal(structure.animatedOpacity, false, 'Only the stationary silhouette has reduced opacity');
      assert.deepEqual(structure.missingReferences, []);
      assert.deepEqual(structure.externalResources, []);
      assert.equal(structure.scripts, 0);
      assert.equal(structure.clippedInformation, false, 'Typing must reveal whole characters, not crop glyphs');
      assert.equal(structure.durations.length, structure.typedCharacters + 6);
      assert.deepEqual([...structure.durations].sort((a,b) => a-b), [1000, ...Array(structure.typedCharacters + 5).fill(10800)]);
      const expectedPhaseMs = [0, 2200, 7400, 9600, 10800];
      assert.equal(structure.portraitPhaseMs.length, expectedPhaseMs.length);
      structure.portraitPhaseMs.forEach((milliseconds, index) => assert(Math.abs(milliseconds - expectedPhaseMs[index]) < .001, 'Requested phase boundaries must be exact'));
      for (const b of structure.textBounds) assert(b.x >= 0 && b.y >= 0 && b.x + b.width <= g.width && b.y + b.height <= g.height, 'Text overflow: ' + name + ' ' + b.text);
      for (let i = 0; i < structure.textBounds.length; i++) for (let j = i + 1; j < structure.textBounds.length; j++) {
        const a = structure.textBounds[i], b = structure.textBounds[j];
        assert(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y), 'Text overlap: ' + a.text + ', ' + b.text);
      }
      report.structure.push({ name, bytes: Buffer.byteLength(source), ...structure });

      const opening = await positions(page, 1.1);
      const settled = await positions(page, 3.5);
      const erasing = await positions(page, 8.5);
      const hidden = await positions(page, 10.2);
      for (const state of [opening, settled, erasing, hidden]) {
        assert.equal(state.imageTransform, 'none', 'Portrait itself must never translate');
        assert.equal(state.imageOpacity, '1', 'Portrait must stay at full opacity');
        assert.equal(state.silhouetteOpacity, '0.02', 'The background silhouette must stay at two percent opacity');
        assert.equal(state.silhouetteTransform, 'none');
        assert.equal(state.silhouetteAnimations, 0);
        assert(state.information.every(row => row.animations === row.count), 'Every character must have a discrete visibility animation');
        assert(state.information.every(row => row.stationary && row.renderedCharacters === row.count), 'Characters and spaces must retain their layout');
        for (const [index, row] of state.information.entries()) assert.deepEqual(row.characterPositions, settled.information[index].characterPositions, 'No text movement or layout shift while typing');
      }
      assert(Math.abs(opening.mask.scaleY - .5) < .001 && opening.mask.y === 0, 'Reveal from top downward');
      assert.equal(settled.mask.scaleY, 1);
      assert(Math.abs(erasing.mask.scaleY - .5) < .001 && erasing.mask.y === 0, 'Erase from bottom upward');
      assert.equal(hidden.mask.scaleY, 0);
      assert(settled.information.every(row => row.visibleCount === row.count));
      assert(hidden.information.every(row => row.visibleCount === 0));
      const rowStates = [];
      // Sample between glyph boundaries; exact CSS step edges can round either way.
      for (const seconds of [0, .011, .151, .451, .801, 1.101, 1.401, 2.201, 7.399, 7.401, 7.701, 8.501, 9.201, 9.601]) {
        const state = await positions(page, seconds);
        for (const row of state.information) {
          const expected = Array.from({ length: row.count }, (_, index) => {
            const offset = 2.2 * index / (row.count - 1);
            return seconds + 1e-7 >= offset && seconds < 9.6 - offset - 1e-7;
          });
          assert.deepEqual(row.visible, expected, 'Parallel character timing for ' + row.id + ' at ' + seconds + 's');
          assert.deepEqual(row.visible, Array.from({ length: row.count }, (_, index) => index < row.visibleCount), 'Characters must form an unbroken prefix');
          assert.equal(row.visibleText, Array.from(row.text).slice(0, row.visibleCount).join(''));
        }
        if (seconds === 0 || seconds === .011) assert(state.information.every(row => row.visibleCount === 1), 'Every row must start with the portrait scan');
        if (seconds === 2.201 || seconds === 7.399) assert(state.information.every(row => row.visibleCount === row.count));
        if (seconds === 9.601) assert(state.information.every(row => row.visibleCount === 0));
        rowStates.push({ seconds, rows: state.information.map(row => ({ id: row.id, characters: row.visibleCount, visibleText: row.visibleText })) });
      }
      const scanStates = [];
      for (const seconds of [.55, 1.65, 7.95, 9.05]) {
        const state = await positions(page, seconds);
        assert(Math.abs(state.scanner.y - state.mask.scaleY * g.size) < .03, 'Scanner must track the reveal boundary');
        scanStates.push({ seconds, y: state.scanner.y });
      }
      assert(scanStates[0].y < scanStates[1].y, 'Opening scan must travel downward');
      assert(scanStates[2].y > scanStates[3].y, 'Erasing scan must travel upward');
      const typeStates = [];
      for (const seconds of [.011, .4, 1.2, 3.5, 7.8, 9, 9.8]) {
        const state = await positions(page, seconds);
        const count = state.information.find(row => row.id === 'role').visibleCount;
        assert(Math.abs(state.caret.x - count / state.characters * state.roleWidth) < .01, 'Cursor must follow the last whole character');
        typeStates.push({ seconds, characters: count });
      }
      assert(typeStates[0].characters === 1 && typeStates[3].characters === 18 && typeStates[6].characters === 0);
      assert(typeStates[1].characters < typeStates[2].characters && typeStates[4].characters > typeStates[5].characters);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'Direct SVG reduced motion');
      assert((await page.evaluate(() => [...document.querySelectorAll('.motion')].map(el => getComputedStyle(el).transform))).every(transform => transform === 'none'));

      const full = await frame(page, source, g, 3.5);
      const hold = await frame(page, source, g, 4.5);
      assert.equal(delta(await raw(full), await raw(hold)), 0, 'Reading interval must be stationary');
      buffers.set(name, full);
      fs.writeFileSync(path.join(out, name + '-full.png'), full);
      for (const [label, reduced, fallback] of [['reduced', true, false], ['fallback', false, true]]) {
        const image = await frame(page, source, g, 10.2, { reduced, fallback });
        assert.equal(delta(await raw(full), await raw(image)), 0, label + ' must keep all content visible');
        fs.writeFileSync(path.join(out, name + '-' + label + '.png'), image);
      }
      const openingFrame = await frame(page, source, g, 1.1);
      const erasingFrame = await frame(page, source, g, 8.5);
      const silhouette = await frame(page, source, g, 10.2, { silhouetteOnly: true });
      silhouetteBuffers.set(name, silhouette);
      const silhouetteVisibility = await faintSilhouette(silhouette, g, theme);
      await portraitPart(openingFrame, full, g, 'top');
      await portraitPart(openingFrame, silhouette, g, 'bottom');
      await portraitPart(erasingFrame, full, g, 'top');
      await portraitPart(erasingFrame, silhouette, g, 'bottom');
      const alpha = await portraitAlpha(page, source, g.size);
      const silhouetteChecks = [];
      for (const seconds of [.55, 1.1, 1.65, 7.95, 8.5, 9.05]) silhouetteChecks.push(await scanCoverage(page, source, g, seconds, alpha));
      const erased = await frame(page, source, g, 10.2);
      await silhouettePortrait(erased, silhouette, g);
      for (const [label, image] of [['opening', openingFrame], ['erasing', erasingFrame], ['silhouette', erased]]) {
        fs.writeFileSync(path.join(out, name + '-' + label + '.png'), image);
      }
      await emptyInfo(erased, mobile, theme);
      const textChecks = [];
      for (const [seconds, expectedRows] of [[.011, 5], [.5, 5], [1.1, 5], [1.7, 5], [2.3, 5], [7.3, 5], [7.8, 5], [8.5, 5], [9.2, 5], [9.8, 0], [10.799, 0]]) {
        const image = await frame(page, source, g, seconds);
        const pixels = await infoPixels(image, mobile, theme);
        assert.deepEqual(pixels.map(count => count > 0), Array.from({ length: 5 }, (_, index) => index < expectedRows), 'All rows type in parallel at ' + seconds + 's in ' + name);
        textChecks.push({ seconds, pixels });
        fs.writeFileSync(path.join(out, name + '-info-' + seconds + 's.png'), image);
      }
      const typingEmpty = erased;
      const typeRect = { left: (mobile ? 20 : 300) + 20, top: mobile ? 320 : 140, width: Math.ceil(settled.roleWidth) + 3, height: 36 };
      await solid(typingEmpty, typeRect, theme === 'dark' ? [11,15,20] : [248,250,252], 'Erased title must not leave ghost text');
      fs.writeFileSync(path.join(out, name + '-typing-empty.png'), typingEmpty);
      fs.writeFileSync(path.join(out, name + '-typing-partial.png'), await frame(page, source, g, 1.2));
      for (const seconds of [0, 10.799, 10.8]) {
        const boundary = await frame(page, source, g, seconds);
        await silhouettePortrait(boundary, silhouette, g);
        if (seconds === 10.799) await emptyInfo(boundary, mobile, theme);
        else assert((await infoPixels(boundary, mobile, theme)).every(count => count > 0), 'All text starts with the new scan cycle');
      }
      const repeated = await frame(page, source, g, 46.7);
      assert.equal(delta(await raw(full), await raw(repeated)), 0, 'Both animation cycles must repeat without drift');
      report.animation.push({ name, portrait: 'stationary, top-down reveal and bottom-up erase', portraitPeriodSeconds: 10.8, phaseSeconds: { reveal: 2.2, hold: 5.2, erase: 2.2, idle: 1.2 }, scanDirection: scanStates, silhouetteChecks, silhouetteOpacity: .02, silhouetteVisibility, scanHeight: 4, titlePeriodSeconds: 10.8, characterStepping: typeStates, information: 'parallel whole-character typing and reverse deletion', rowStates, textChecks, erasedPortrait: 'faint silhouette only', emptyInformationPixels: 0, reducedMotion: 'pass', fallback: 'pass', loopBoundary: 'pass' });
      console.log('Validated ' + name + ': parallel character typing, synchronized deletion, stationary glyphs, 2% silhouette and reduced motion');
    }

    for (const width of [320, 375, 768, 1440]) for (const theme of ['dark', 'light']) for (const reduced of [false, true]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.goto(pathToFileURL(path.join(root, 'preview.html')).href);
      await page.locator('picture img').evaluate(img => img.decode());
      const layout = await page.evaluate(() => {
        const img = document.querySelector('picture img');
        const b = img.getBoundingClientRect();
        const grid = document.querySelector('.capabilities');
        const cards = [...grid.querySelectorAll('article')].map(card => {
          const bounds = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          const heading = card.querySelector('h3').getBoundingClientRect();
          const paragraph = card.querySelector('p').getBoundingClientRect();
          return {
            x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
            border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
            radius: style.borderRadius,
            contentFits: [heading, paragraph].every(child => child.x >= bounds.x && child.right <= bounds.right && child.y >= bounds.y && child.bottom <= bounds.bottom) && heading.bottom <= paragraph.y,
          };
        });
        return { src: img.currentSrc.split('/').pop(), width: b.width, height: b.height, overflow: document.documentElement.scrollWidth > innerWidth, loaded: img.complete && img.naturalWidth > 0, reducedButtonDisabled: document.querySelector('button').disabled, cardColumns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, cards };
      });
      assert(layout.loaded && !layout.overflow);
      const mobile = width < 768;
      assert.equal(layout.cardColumns, mobile ? 1 : 2);
      assert.equal(layout.cards.length, content.capabilities.length);
      for (const card of layout.cards) {
        assert(card.contentFits, 'Architecture card text must stay within its border');
        assert.deepEqual(card.border, ['1px', '1px', '1px', '1px']);
        assert.equal(card.radius, '6px');
      }
      if (mobile) assert(layout.cards.every(card => card.x === layout.cards[0].x));
      else {
        assert.equal(layout.cards[0].y, layout.cards[1].y);
        assert(layout.cards[1].x >= layout.cards[0].x + layout.cards[0].width + 15);
        assert.equal(layout.cards.at(-1).width, layout.width, 'The final odd card spans the grid');
      }
      const name = theme + (mobile ? '-mobile' : '');
      assert.equal(layout.src, name + '.svg' + (reduced ? '#still' : ''));
      assert.equal(layout.reducedButtonDisabled, reduced);
      const textBounds = report.structure.find(item => item.name === name).textBounds;
      const scale = layout.width / geometry(mobile).width;
      const minBodyPixels = Math.min(...textBounds.filter(item => !item.mono).map(item => item.fontSize)) * scale;
      assert(minBodyPixels >= 16, 'Profile body text must be readable at ' + width + 'px');
      if (reduced) {
        await page.screenshot({ path: path.join(out, 'profile-' + width + '-' + theme + '.png'), fullPage: true });
        await page.locator('section[aria-labelledby="architecture"]').screenshot({ path: path.join(out, 'architecture-' + width + '-' + theme + '.png') });
        const first = await page.locator('picture img').screenshot();
        await page.waitForTimeout(180);
        const second = await page.locator('picture img').screenshot();
        const stationaryDelta = delta(await raw(first), await raw(second));
        if (stationaryDelta > 1) {
          fs.writeFileSync(path.join(out, 'stationary-first-' + width + '-' + theme + '.png'), first);
          fs.writeFileSync(path.join(out, 'stationary-second-' + width + '-' + theme + '.png'), second);
        }
        // Allow one 8-bit channel level of raster rounding, not geometric motion.
        assert(stationaryDelta <= 1, 'Reduced motion image must be stationary at ' + width + 'px in ' + theme + ': max channel difference ' + stationaryDelta);
        layout.stationaryMaxChannelDifference = stationaryDelta;
        // A paused image must contain the source portrait, not just a still blank frame.
        const g = geometry(mobile);
        const area = { left: Math.ceil((g.x + 24) * scale), top: Math.ceil((g.y + 24) * scale), width: Math.floor((g.size - 48) * scale), height: Math.floor((g.size - 48) * scale) };
        const pixels = await raw(first, area);
        let skinPixels = 0;
        for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > 90 && pixels[i] > pixels[i + 1] * 1.15 && pixels[i + 1] > pixels[i + 2] * 1.1) skinPixels++;
        assert(skinPixels > 100, 'Static portrait must be visibly present');
      }
      report.responsive.push({ viewport: width, theme, reducedMotion: reduced, minBodyPixels, ...layout });
    }
    console.log('Validated 320/375/768/1440px, both themes, 16px minimum body text and reduced motion');

    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
    await page.goto(pathToFileURL(path.join(root, 'preview.html')).href);
    const toggle = page.getByRole('button', { name: 'Show static profile' });
    await toggle.click();
    await page.locator('picture img').evaluate(img => img.decode());
    assert.equal(await page.locator('button').getAttribute('aria-pressed'), 'true');
    assert((await page.locator('picture img').evaluate(img => img.currentSrc)).endsWith('#still'));
    await page.getByRole('button', { name: 'Animate profile' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('button').getAttribute('aria-pressed'), 'false');
    assert(!(await page.locator('picture img').evaluate(img => img.currentSrc)).endsWith('#still'));
    report.interaction = { staticToggle: 'pass', keyboard: 'pass' };

    const g = geometry(false);
    await page.setViewportSize({ width: g.width, height: g.height });
    await page.goto('about:blank');
    await page.setContent('<body style="margin:0"><img alt="Real time cycle" style="display:block"></body>');
    await page.locator('img').evaluate((img, source) => new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source); }), sources.dark);
    const start = performance.now();
    let hold;
    for (const seconds of [1.1, 3.5, 8.5, 10.2, 11.9, 14.3, 19.3, 21, 22.1]) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, seconds * 1000 - (performance.now() - start))));
      const image = await page.screenshot();
      fs.writeFileSync(path.join(out, 'live-' + seconds.toFixed(1) + 's.png'), image);
      const phase = seconds % 10.8;
      if (phase > 9.6) {
        await silhouettePortrait(image, silhouetteBuffers.get('dark'), g);
        await emptyInfo(image, false, 'dark');
      }
      if (phase > 2.2 && phase < 7.4) {
        const counts = await infoPixels(image, false, 'dark');
        assert(counts.every(count => count > 50), 'All information must remain readable during the hold');
      }
      if (seconds === 3.5) hold = image;
      if (seconds === 14.3) {
        const area = { left: g.x + 12, top: g.y + 12, width: g.size - 24, height: g.size - 24 };
        assert.equal(delta(await raw(hold, area), await raw(image, area)), 0, 'Real-time portrait holds must match');
      }
      report.cycles.push({ requestedSeconds: seconds, actualSeconds: (performance.now() - start) / 1000, passed: true });
    }

    const avatarFile = path.join(root, 'assets/avatar2-500.png');
    const avatar = await sharp(avatarFile).metadata();
    assert.equal(avatar.width, 500); assert.equal(avatar.height, 500); assert(avatar.hasAlpha);
    assert(fs.statSync(avatarFile).size < 1000000);
    report.avatar = { width: avatar.width, height: avatar.height, alpha: avatar.hasAlpha, bytes: fs.statSync(avatarFile).size };
    const generated = ['README.md', 'preview.html', 'dark.svg', 'light.svg', 'dark-mobile.svg', 'light-mobile.svg'];
    const hashes = () => generated.map(name => createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'));
    const before = hashes();
    execFileSync(process.execPath, [path.join(__dirname, 'build-profile.cjs')], { cwd: root, stdio: 'pipe' });
    assert.deepEqual(hashes(), before);
    report.idempotentBuild = true;
    report.status = 'passed';
    console.log('Passed motion controls, two complete real-time cycles, alpha avatar and reproducible build');
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(resultDir, 'validation.json'), JSON.stringify(report, null, 2));
    await browser?.close();
  }
})();
