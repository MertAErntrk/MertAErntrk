const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'previews/v17');
const rotation = JSON.parse(fs.readFileSync(path.join(root, 'assets/avatar-rotation.json'), 'utf8'));
fs.mkdirSync(out, { recursive: true });
const phaseAt = seconds => seconds < 2.2 ? 'reveal' : seconds < 7.4 ? 'hold' : seconds < 9.6 ? 'erase' : 'silhouette';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PROFILE_TEST_CHANNEL || 'chrome' });
  const results = [];
  try {
    for (const throttle of process.env.PROFILE_PERF_CPU ? [Number(process.env.PROFILE_PERF_CPU)] : [1, 4]) {
      const context = await browser.newContext({ viewport: { width: 320, height: 462 }, deviceScaleFactor: 1, reducedMotion: 'no-preference', colorScheme: 'dark',
        ...(throttle === 1 ? { recordVideo: { dir: out, size: { width: 320, height: 462 } } } : {}) });
      const page = await context.newPage();
      await page.goto(pathToFileURL(path.join(root, 'preview.html')).href);
      // Exercise the GitHub rendering path: SVG loaded as an external image, not inline SVG.
      await page.setContent('<body style="margin:0"><img alt="Rotation performance test" width="320" height="462" style="display:block"></body>');
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      const captures = [];
      let start;
      client.on('Page.screencastFrame', event => {
        client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
        if (start) captures.push({ time: Date.now() - start, png: Buffer.from(event.data, 'base64') });
      });
      await client.send('Page.startScreencast', { format: 'png', maxWidth: 320, maxHeight: 462, everyNthFrame: 1 });
      await page.locator('img').evaluate((img, url) => new Promise((resolve, reject) => {
        img.onload = resolve; img.onerror = reject; img.src = url;
      }), pathToFileURL(path.join(root, process.env.PROFILE_PERF_SVG || 'dark-mobile.svg')).href + '?performance=' + throttle);
      start = Date.now();
      await page.waitForTimeout(10800);
      await client.send('Page.stopScreencast');
      const video = page.video();
      await context.close();
      if (video) await video.saveAs(path.join(out, 'stepped-rotation-' + throttle + 'x.webm'));
      let previousHash, lastChange;
      const phases = Object.fromEntries(['reveal', 'hold', 'erase', 'silhouette'].map(phase => [phase, { changes: 0, maxGapMs: 0 }]));
      for (const capture of captures) {
        const pixels = await sharp(capture.png).extract({ left: 72, top: 72, width: 176, height: 176 }).raw().toBuffer();
        const hash = createHash('sha256').update(pixels).digest('hex');
        if (hash === previousHash) continue;
        const phase = phases[phaseAt(Math.min(capture.time / 1000, 10.799))];
        phase.changes++;
        if (lastChange !== undefined) phase.maxGapMs = Math.max(phase.maxGapMs, capture.time - lastChange);
        lastChange = capture.time;
        previousHash = hash;
      }
      const warnings = [];
      const phaseSeconds = { reveal: 2.2, hold: 5.2, erase: 2.2, silhouette: 1.2 };
      const frameMs = 1000 / rotation.fps;
      for (const [name, phase] of Object.entries(phases)) {
        if (phase.changes < Math.floor(phaseSeconds[name] * rotation.fps) - 1) warnings.push('Low rendered frame count during ' + name);
        if (phase.maxGapMs >= frameMs + (throttle === 1 ? 150 : 300)) warnings.push('Long captured frame interval during ' + name + ': ' + phase.maxGapMs + 'ms');
      }
      if (phases.hold.changes / 5.2 < rotation.fps * .85) warnings.push('Hold cadence below target');
      results.push({ cpuThrottle: throttle, targetFps: rotation.fps, captures: captures.length, observedHoldFps: Number((phases.hold.changes / 5.2).toFixed(1)), phases, warnings });
      console.log(JSON.stringify(results.at(-1)));
      // Throttled screencasts are hardware-dependent diagnostics; never hide their warnings.
      if (throttle === 1) assert.deepEqual(warnings, [], 'Normal-speed rendering must meet the frame cadence budget');
    }
    const status = results.some(result => result.warnings.length) ? 'passed_with_stress_warning' : 'passed';
    fs.writeFileSync(path.join(root, 'test-results/rotation-performance.json'), JSON.stringify({ status, results }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(root, 'test-results/rotation-performance.json'), JSON.stringify({ status: 'failed', results, error: error.message }, null, 2));
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
