const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'previews/v4');
const resultDir = path.join(root, 'test-results');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(resultDir, { recursive: true });
const report = { checkedAt: new Date().toISOString(), revision: 'silhouette-scan-v4', structure: [], animation: [], responsive: [], cycles: [], limitations: ['Local Chrome only. GitHub-hosted rendering was not tested.', 'The motion toggle is available in the local HTML preview, not inside GitHub image embeds.'] };
const geometry = mobile => mobile ? { width: 320, height: 462, x: 64, y: 64, size: 192 } : { width: 960, height: 352, x: 32, y: 76, size: 224 };
const buffers = new Map();

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
async function emptyPortrait(image, g, theme) {
  await solid(image, { left: g.x + 12, top: g.y + 12, width: g.size - 24, height: g.size - 24 },
    theme === 'dark' ? [17, 24, 32] : [234, 240, 244], 'No portrait pixels may remain in the empty state');
}
async function portraitPart(image, full, g, theme, part, empty) {
  const rect = { left: g.x + 12, top: g.y + (part === 'top' ? 12 : Math.floor(g.size * .75)), width: g.size - 24, height: Math.floor(g.size * .25) - 12 };
  if (empty) await solid(image, rect, theme === 'dark' ? [17, 24, 32] : [234, 240, 244], 'Scan must fully clear ' + part);
  else assert.equal(delta(await raw(image, rect), await raw(full, rect)), 0, 'The visible photo must not move or fade');
}
async function stableText(image, full, mobile) {
  const areas = mobile ?
    [{ left: 20, top: 270, width: 280, height: 45 }, { left: 20, top: 365, width: 280, height: 60 }] :
    [{ left: 300, top: 77, width: 628, height: 50 }, { left: 300, top: 200, width: 628, height: 65 }];
  for (const area of areas) assert.equal(delta(await raw(image, area), await raw(full, area)), 0, 'Name and description must stay fixed');
}
async function frame(page, source, g, seconds, reduced = false, fallback = false, hideScan = false) {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const src = await page.evaluate(({ source, seconds, fallback, hideScan }) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = fallback ? '.motion{animation:none!important;transform:none!important}.scan-line,.type-cursor{display:none!important}' :
      '.motion{animation-play-state:paused!important;animation-delay:-' + seconds + 's!important}';
    if (hideScan) style.textContent += '.scan-line{display:none!important}';
    doc.documentElement.appendChild(style);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(doc));
  }, { source, seconds, fallback, hideScan });
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
  const hidden = await frame(page, source, g, seconds, false, false, true);
  const area = { left: g.x, top: g.y, width: g.size, height: g.size };
  const a = await raw(visible, area), b = await raw(hidden, area);
  let changedPixels = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (Math.max(...[0, 1, 2].map(channel => Math.abs(a[i * 3 + channel] - b[i * 3 + channel]))) <= 1) continue;
    assert(alpha[i] > 0, 'Scan must not cross transparent pixels at ' + seconds + 's: ' + (i % g.size) + ',' + Math.floor(i / g.size));
    changedPixels++;
  }
  assert(changedPixels > 20, 'Scan must remain visible within the portrait');
  return { seconds, changedPixels, pixelsOutsideSilhouette: 0 };
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
      typing: matrix('.type-window'),
      caret: matrix('.cursor-travel'),
      roleWidth: Number(document.querySelector('.type-window').getAttribute('width')),
      characters: document.querySelector('.role').textContent.length,
      imageTransform: getComputedStyle(document.querySelector('.portrait-image')).transform,
      imageOpacity: getComputedStyle(document.querySelector('.portrait-image')).opacity,
      fixedTextAnimations: [...document.querySelectorAll('.name,.body')].reduce((count, el) => count + el.getAnimations().length, 0),
    };
  }, seconds);
}

(async () => {
  let browser;
  try {
    const content = JSON.parse(fs.readFileSync(path.join(root, 'profile-content.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert(!/Selected Works?|## Toolkit|Solution Architect|solution architecture/i.test(readme));
    assert(!/at the intersection|intelligent applications|coherent platform|agentic systems/i.test(readme));
    assert(!/\bPython\b|\bSQL\b/.test(readme));
    for (const title of [...content.roles, ...content.capabilities.map(item => item.title), ...content.focus.map(item => item.title)]) assert(readme.includes(title), 'README missing ' + title);
    assert(content.capabilities.length === 7 && content.focus.length === 3);

    browser = await chromium.launch({ headless: true, ...(process.env.PROFILE_TEST_CHANNEL ? { channel: process.env.PROFILE_TEST_CHANNEL } : {}) });
    const page = await browser.newPage({ deviceScaleFactor: 1 });
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
          missingReferences: refs.filter(id => !doc.getElementById(id)),
          externalResources: [...doc.querySelectorAll('[href]')].map(el => el.getAttribute('href')).filter(href => !href.startsWith('#') && !href.startsWith('data:')),
          scripts: doc.querySelectorAll('script,foreignObject').length,
          durations: document.getAnimations().map(a => a.effect.getTiming().duration),
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
      assert.equal(structure.uses, 2);
      assert.equal(structure.alphaMask, 'alpha');
      assert.equal(structure.alphaSource, '#portrait');
      assert.equal(structure.scannerMask, 'url(#portrait-alpha)');
      assert.deepEqual(structure.missingReferences, []);
      assert.deepEqual(structure.externalResources, []);
      assert.equal(structure.scripts, 0);
      assert.equal(structure.durations.length, 5);
      assert.deepEqual([...structure.durations].sort((a,b) => a-b), [1000, 8000, 8000, 10000, 10000]);
      assert(!source.includes('opacity'), 'The portrait must be masked, not faded');
      for (const b of structure.textBounds) assert(b.x >= 0 && b.y >= 0 && b.x + b.width <= g.width && b.y + b.height <= g.height, 'Text overflow: ' + name + ' ' + b.text);
      for (let i = 0; i < structure.textBounds.length; i++) for (let j = i + 1; j < structure.textBounds.length; j++) {
        const a = structure.textBounds[i], b = structure.textBounds[j];
        assert(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y), 'Text overlap: ' + a.text + ', ' + b.text);
      }
      report.structure.push({ name, bytes: Buffer.byteLength(source), ...structure });

      const opening = await positions(page, .8);
      const settled = await positions(page, 3.5);
      const erasing = await positions(page, 7.6);
      const hidden = await positions(page, 9.2);
      for (const state of [opening, settled, erasing, hidden]) {
        assert.equal(state.imageTransform, 'none', 'Portrait itself must never translate');
        assert.equal(state.imageOpacity, '1', 'Portrait must stay at full opacity');
        assert.equal(state.fixedTextAnimations, 0, 'Only the role gets a typing effect');
      }
      assert(Math.abs(opening.mask.scaleY - .5) < .001 && Math.abs(opening.mask.y - g.size / 2) < .01, 'Reveal from bottom upward');
      assert.equal(settled.mask.scaleY, 1);
      assert(Math.abs(erasing.mask.scaleY - .5) < .001 && Math.abs(erasing.mask.y - g.size / 2) < .01, 'Erase from top downward');
      assert.equal(hidden.mask.scaleY, 0);
      const scanStates = [];
      for (const seconds of [.4, 1.2, 7.2, 8]) {
        const state = await positions(page, seconds);
        assert(Math.abs(state.scanner.y - state.mask.y) < .03, 'Scanner must track the reveal boundary');
        scanStates.push({ seconds, y: state.scanner.y });
      }
      assert(scanStates[0].y > scanStates[1].y, 'Opening scan must travel upward');
      assert(scanStates[2].y < scanStates[3].y, 'Erasing scan must travel downward');
      const typeStates = [];
      for (const seconds of [.4, .8, 1.2, 2.8, 5.6, 6.4, 7.5]) {
        const state = await positions(page, seconds);
        const count = state.typing.scaleX * state.characters;
        assert(Math.abs(count - Math.round(count)) < .001, 'Typing must stop on whole character boundaries');
        assert(Math.abs(state.caret.x - state.typing.scaleX * state.roleWidth) < .01, 'Cursor must follow the text edge');
        typeStates.push({ seconds, characters: Math.round(count) });
      }
      assert(typeStates[0].characters === 0 && typeStates[3].characters === 18 && typeStates[6].characters === 0);
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
        const image = await frame(page, source, g, 9.2, reduced, fallback);
        assert.equal(delta(await raw(full), await raw(image)), 0, label + ' must keep all content visible');
        fs.writeFileSync(path.join(out, name + '-' + label + '.png'), image);
      }
      const openingFrame = await frame(page, source, g, .8);
      const erasingFrame = await frame(page, source, g, 7.6);
      await portraitPart(openingFrame, full, g, theme, 'top', true);
      await portraitPart(openingFrame, full, g, theme, 'bottom', false);
      await portraitPart(erasingFrame, full, g, theme, 'top', true);
      await portraitPart(erasingFrame, full, g, theme, 'bottom', false);
      const alpha = await portraitAlpha(page, source, g.size);
      const silhouetteChecks = [];
      for (const seconds of [.4, .8, 1.2, 7.2, 7.6, 8]) silhouetteChecks.push(await scanCoverage(page, source, g, seconds, alpha));
      const empty = await frame(page, source, g, 9.2);
      await emptyPortrait(empty, g, theme);
      for (const [label, image] of [['opening', openingFrame], ['erasing', erasingFrame], ['empty', empty]]) {
        await stableText(image, full, mobile);
        fs.writeFileSync(path.join(out, name + '-' + label + '.png'), image);
      }
      const typingEmpty = await frame(page, source, g, 7.5);
      const typeRect = { left: (mobile ? 20 : 300) + 20, top: mobile ? 320 : 140, width: Math.ceil(settled.roleWidth) + 3, height: 36 };
      await solid(typingEmpty, typeRect, theme === 'dark' ? [11,15,20] : [248,250,252], 'Erased title must not leave ghost text');
      fs.writeFileSync(path.join(out, name + '-typing-empty.png'), typingEmpty);
      fs.writeFileSync(path.join(out, name + '-typing-partial.png'), await frame(page, source, g, 1.2));
      for (const seconds of [9.999, 10]) await emptyPortrait(await frame(page, source, g, seconds), g, theme);
      const repeated = await frame(page, source, g, 43.5);
      assert.equal(delta(await raw(full), await raw(repeated)), 0, 'Both animation cycles must repeat without drift');
      report.animation.push({ name, portrait: 'stationary, bottom-up reveal and top-down erase', portraitPeriodSeconds: 10, scanDirection: scanStates, silhouetteChecks, titlePeriodSeconds: 8, characterStepping: typeStates, nameAndDescription: 'stationary', emptyPortraitPixels: 0, emptyTitlePixels: 0, reducedMotion: 'pass', fallback: 'pass', loopBoundary: 'pass' });
      console.log('Validated ' + name + ': XML, layout, stationary portrait, silhouette-only bidirectional scan, character typing and reduced motion');
    }

    for (const width of [320, 375, 768, 1440]) for (const theme of ['dark', 'light']) for (const reduced of [false, true]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.goto(pathToFileURL(path.join(root, 'preview.html')).href);
      await page.locator('picture img').evaluate(img => img.decode());
      const layout = await page.evaluate(() => {
        const img = document.querySelector('picture img');
        const b = img.getBoundingClientRect();
        return { src: img.currentSrc.split('/').pop(), width: b.width, height: b.height, overflow: document.documentElement.scrollWidth > innerWidth, loaded: img.complete && img.naturalWidth > 0, reducedButtonDisabled: document.querySelector('button').disabled };
      });
      assert(layout.loaded && !layout.overflow);
      const mobile = width < 768;
      const name = theme + (mobile ? '-mobile' : '');
      assert.equal(layout.src, name + '.svg' + (reduced ? '#still' : ''));
      assert.equal(layout.reducedButtonDisabled, reduced);
      const textBounds = report.structure.find(item => item.name === name).textBounds;
      const scale = layout.width / geometry(mobile).width;
      const minBodyPixels = Math.min(...textBounds.filter(item => !item.mono).map(item => item.fontSize)) * scale;
      assert(minBodyPixels >= 16, 'Profile body text must be readable at ' + width + 'px');
      if (reduced) {
        await page.screenshot({ path: path.join(out, 'profile-' + width + '-' + theme + '.png'), fullPage: true });
        const first = await page.locator('picture img').screenshot();
        await page.waitForTimeout(180);
        const second = await page.locator('picture img').screenshot();
        const stationaryDelta = delta(await raw(first), await raw(second));
        // Allow one 8-bit channel level of raster rounding, not geometric motion.
        assert(stationaryDelta <= 1, 'Reduced motion image must be stationary');
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
    for (const seconds of [.8, 3.5, 7.6, 9.2, 10.8, 13.5, 17.6, 19.2, 20.5]) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, seconds * 1000 - (performance.now() - start))));
      const image = await page.screenshot();
      fs.writeFileSync(path.join(out, 'live-' + seconds.toFixed(1) + 's.png'), image);
      const phase = seconds % 10;
      if (phase > 8.4) await emptyPortrait(image, g, 'dark');
      await stableText(image, buffers.get('dark'), false);
      if (seconds === 3.5) hold = image;
      if (seconds === 13.5) {
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
