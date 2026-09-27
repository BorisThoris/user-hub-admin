// Shared browser plumbing for this project's media scripts: the screenshot
// run, the recorded trailer and the media tests all drive the app through the
// same recipe vocabulary, judge frames the same way and find Playwright the
// same way, so a recipe that passes the test is the recipe that ships.
//
// Recipe actions (capture.actions, a trailer's recipe.actions):
//   { type: 'wait', ms }                                   pause
//   { type: 'waitFor', target, state?, timeoutMs? }        wait for an element
//   { type: 'click' | 'check' | 'uncheck' | 'hover', target }
//   { type: 'fill' | 'type', target, value }
//   { type: 'press', key }                                 one key press (Playwright key names)
//   { type: 'tap', at: [x, y] }                            click a point of the viewport (a canvas button)
//   { type: 'key', key, holdMs }                           hold a key down (a game control)
//   { type: 'keys', keys: [..], eachMs }                   a sequence of presses
//   { type: 'mouse', to: [x, y], steps?, holdMs? }         move the pointer (fractions of the viewport)
//   { type: 'drag', from: [x, y], to: [x, y], steps? }     press, move, release
//   { type: 'scroll', deltaY, steps?, eachMs? }            wheel-scroll the page
//   Every action takes `label` (for logs) and `optional: true` (a failure is a
//   note, not an error). A target is { role, name }, { text } or { selector }.
//
// Installed by the portfolio meta toolkit; edit the template there.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const PROFILES = {
  card: { width: 1600, height: 900, quality: 90 },
  desktop: { width: 1440, height: 900, quality: 90 },
  mobile: { width: 430, height: 932, quality: 88, isMobile: true, hasTouch: true },
  full: { width: 1440, height: 900, quality: 86, fullPage: true },
  og: { width: 1200, height: 630, quality: 92 }
};

// What a "good" frame looks like: not a blank or a loading screen. A project
// overrides any of these in capture.quality / recipe.quality.
export const DEFAULT_QUALITY = {
  minStd: 10, // luminance spread across the frame (0-255)
  maxDark: 0.97, // at most this fraction of samples nearly black
  maxLight: 0.98, // at most this fraction nearly white
  minColours: 6 // distinct coarse colours
};

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ browser

export async function loadChromium(repoRoot, config) {
  const candidates = [repoRoot];
  const portfolioRoot = config?.media?.sourceDir ? path.resolve(config.media.sourceDir, '..', '..', '..', '..') : null;
  if (process.env.PORTFOLIO_ROOT) candidates.push(process.env.PORTFOLIO_ROOT);
  if (portfolioRoot) candidates.push(portfolioRoot);

  for (const base of candidates) {
    for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
      try {
        const require_ = createRequire(path.join(base, 'package.json'));
        const resolved = require_.resolve(name);
        const module_ = await import(pathToFileURL(resolved).href);
        const chromium_ = module_.chromium ?? module_.default?.chromium;
        if (chromium_) return chromium_;
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error('Playwright not found: install it here (npm i -D @playwright/test && npx playwright install chromium) or set PORTFOLIO_ROOT to a checkout that has it.');
}

// Where to photograph: 'deployment' (default when the project has one),
// 'local' (start the dev server) or an explicit URL.
export async function resolveBaseUrl(config, repoRoot, { source, url, log = console.log } = {}) {
  const chosen = source ?? (url ? 'explicit' : config.curated?.deploymentUrl ? 'deployment' : 'local');
  if (chosen === 'explicit') return { url, source: chosen, stop: async () => {} };
  if (chosen === 'deployment') {
    if (!config.curated?.deploymentUrl) throw new Error('this project has no deploymentUrl; use --source=local or --url=...');
    return { url: config.curated.deploymentUrl, source: chosen, stop: async () => {} };
  }
  const server = await startLocalServer(config, repoRoot, log);
  return { url: server.url, source: 'local', stop: server.stop };
}

export async function startLocalServer(config, repoRoot, log = console.log) {
  const command = config.curated?.runCommand;
  if (!command) throw new Error('no runCommand in project-meta.config.mjs; use --url=... instead');
  const url = config.curated?.localUrl ?? 'http://127.0.0.1:' + (config.curated?.devPort ?? 5173) + '/';
  const cwd = config.curated?.runCwd ? path.join(repoRoot, config.curated.runCwd) : repoRoot;

  if (await probe(url)) {
    log('[media] a server already answers at ' + url + '; using it');
    return { url, stop: async () => {} };
  }
  log('[media] starting: ' + command);
  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  const deadline = Date.now() + (config.curated?.startTimeoutMs ?? 180000);
  while (Date.now() < deadline) {
    if (await probe(url)) return { url, stop: () => stopProcess(child) };
    await delay(1000);
  }
  await stopProcess(child);
  throw new Error('dev server did not answer at ' + url + ' within the start timeout');
}

export async function probe(url) {
  try {
    const response = await globalThis.fetch(url, { redirect: 'follow' });
    return response.ok || response.status === 304;
  } catch {
    return false;
  }
}

export async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('close', resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await delay(500);
}

export function joinUrl(base, suffix) {
  if (!suffix || suffix === '/') return base;
  if (suffix.startsWith('#') || suffix.startsWith('/#')) return base.replace(/\/$/, '') + '/' + suffix.replace(/^\//, '');
  return base.replace(/\/$/, '') + '/' + suffix.replace(/^\//, '');
}

// ------------------------------------------------------------------ recipes

// Brings the page to the state the recipe describes. Strict (the default): a
// ready selector or a required action that fails throws, so a loading screen
// is never photographed by mistake. Returns the notes of optional steps that
// were skipped.
export async function settle(page, recipe = {}, { strict = true, log = console.log } = {}) {
  const skipped = [];
  if (recipe.readySelector) {
    try {
      await page.waitForSelector(recipe.readySelector, {
        state: recipe.readyState ?? 'attached',
        timeout: recipe.readyTimeoutMs ?? 30000
      });
    } catch (error) {
      const message = 'ready selector never appeared: ' + recipe.readySelector;
      if (strict) throw new Error(message);
      skipped.push(message);
      log('[media]   ' + message);
    }
  }

  skipped.push(...(await runActions(page, recipe.actions ?? [], { strict, log })));

  for (const selector of recipe.hideSelectors ?? []) {
    await page.addStyleTag({ content: selector + ' { visibility: hidden !important; }' }).catch(() => {});
  }
  await page.waitForTimeout(recipe.waitAfterReadyMs ?? 1200);
  return skipped;
}

export async function runActions(page, actions, { strict = true, log = console.log } = {}) {
  const skipped = [];
  for (const action of actions) {
    try {
      await runAction(page, action);
    } catch (error) {
      const message = (action.optional ? 'optional step skipped (' : 'action failed (') + (action.label ?? action.type) + '): ' + String(error.message).split('\n')[0];
      if (strict && !action.optional) throw new Error(message);
      skipped.push(message);
      log('[media]   ' + message);
    }
  }
  return skipped;
}

async function runAction(page, action) {
  const timeout = action.timeoutMs ?? 15000;
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const point = ([x, y]) => ({ x: Math.round(x * viewport.width), y: Math.round(y * viewport.height) });
  switch (action.type) {
    case 'wait':
      await page.waitForTimeout(action.ms ?? 500);
      return;
    case 'waitFor':
      await locatorFor(page, action.target).waitFor({ state: action.state ?? 'visible', timeout });
      return;
    case 'click':
      await locatorFor(page, action.target).click({ timeout, force: action.force ?? false });
      return;
    case 'hover':
      await locatorFor(page, action.target).hover({ timeout });
      return;
    case 'check':
      await locatorFor(page, action.target).check({ timeout });
      return;
    case 'uncheck':
      await locatorFor(page, action.target).uncheck({ timeout });
      return;
    case 'fill':
      await locatorFor(page, action.target).fill(action.value ?? '', { timeout });
      return;
    case 'type':
      await locatorFor(page, action.target).pressSequentially(action.value ?? '', { timeout, delay: action.eachMs ?? 40 });
      return;
    case 'press':
      await page.keyboard.press(action.key);
      return;
    case 'tap': {
      // a click at a point of the viewport (fractions), for canvas UIs
      const at = point(action.at ?? [0.5, 0.5]);
      await page.mouse.click(at.x, at.y, { clickCount: action.clicks ?? 1 });
      return;
    }
    case 'key':
      await page.keyboard.down(action.key);
      await page.waitForTimeout(action.holdMs ?? 500);
      await page.keyboard.up(action.key);
      return;
    case 'keys':
      for (const key of action.keys ?? []) {
        await page.keyboard.press(key);
        await page.waitForTimeout(action.eachMs ?? 120);
      }
      return;
    case 'mouse': {
      const to = point(action.to ?? [0.5, 0.5]);
      await page.mouse.move(to.x, to.y, { steps: action.steps ?? 20 });
      if (action.holdMs) await page.waitForTimeout(action.holdMs);
      return;
    }
    case 'drag': {
      const from = point(action.from ?? [0.5, 0.5]);
      const to = point(action.to ?? [0.6, 0.5]);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: action.steps ?? 20 });
      await page.mouse.up();
      return;
    }
    case 'scroll': {
      const steps = action.steps ?? 1;
      for (let index = 0; index < steps; index += 1) {
        await page.mouse.wheel(0, action.deltaY ?? 400);
        await page.waitForTimeout(action.eachMs ?? 250);
      }
      return;
    }
    default:
      throw new Error('unknown action type ' + action.type);
  }
}

export function locatorFor(page, target) {
  if (!target) throw new Error('action has no target');
  if (target.role) return page.getByRole(target.role, { name: target.name, exact: target.exact ?? false }).first();
  if (target.text) return page.getByText(target.text, { exact: target.exact ?? false }).first();
  return page.locator(target.selector ?? target.css ?? target).first();
}

// ------------------------------------------------------------------ judging frames

// Samples the current frame on a coarse grid inside the page (a canvas
// drawn from a screenshot) and reports luminance spread, how much of it is
// black or white, and how many distinct colours it holds.
export async function frameStats(page) {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
  const dataUrl = 'data:image/jpeg;base64,' + buffer.toString('base64');
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const columns = 64;
    const rows = Math.max(8, Math.round((columns * image.height) / image.width));
    const canvas = document.createElement('canvas');
    canvas.width = columns;
    canvas.height = rows;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, columns, rows);
    const data = context.getImageData(0, 0, columns, rows).data;
    let sum = 0;
    let squares = 0;
    let dark = 0;
    let light = 0;
    const colours = new Set();
    const count = columns * rows;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luminance;
      squares += luminance * luminance;
      if (luminance < 16) dark += 1;
      if (luminance > 240) light += 1;
      colours.add(((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5));
    }
    const mean = sum / count;
    return {
      mean: Math.round(mean),
      std: Math.round(Math.sqrt(Math.max(0, squares / count - mean * mean))),
      dark: Number((dark / count).toFixed(3)),
      light: Number((light / count).toFixed(3)),
      colours: colours.size
    };
  }, dataUrl);
}

export function assessFrame(stats, quality = {}) {
  const rules = { ...DEFAULT_QUALITY, ...quality };
  const problems = [];
  if (!stats) return ['no frame statistics'];
  if (stats.std < rules.minStd) problems.push('flat frame (luminance spread ' + stats.std + ' < ' + rules.minStd + ')');
  if (stats.dark > rules.maxDark) problems.push('mostly black (' + Math.round(stats.dark * 100) + '%)');
  if (stats.light > rules.maxLight) problems.push('mostly white (' + Math.round(stats.light * 100) + '%)');
  if (stats.colours < rules.minColours) problems.push('too few colours (' + stats.colours + ' < ' + rules.minColours + ')');
  return problems;
}

// ------------------------------------------------------------------ recording

// Records the recipe as a video: the page is opened in a context that
// records, settled, then the timeline actions run for `durationMs`; the webm
// Playwright wrote is returned with the frame statistics taken mid-way.
export async function recordRecipe(chromium, { url, recipe, outDir, log = console.log }) {
  const viewport = recipe.viewport ?? { width: 1280, height: 720 };
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: recipe.browserArgs ?? [] });
  let videoPath = null;
  let stats = null;
  const skipped = [];
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: recipe.colorScheme ?? 'dark',
      recordVideo: { dir: outDir, size: viewport }
    });
    const page = await context.newPage();
    try {
      await page.goto(joinUrl(url, recipe.route ?? '/'), { waitUntil: 'load', timeout: 60000 });
      skipped.push(...(await settle(page, recipe.setup ?? recipe, { strict: true, log })));
      const started = Date.now();
      // Judged on its best frame: the settled opening and the end of the
      // timeline are both sampled, so a fade or a scene change at one end
      // does not fail a recording that shows the app for the rest of it.
      const opening = await frameStats(page);
      skipped.push(...(await runActions(page, recipe.timeline ?? [], { strict: false, log })));
      const closing = await frameStats(page);
      stats = assessFrame(closing, recipe.quality).length <= assessFrame(opening, recipe.quality).length ? closing : opening;
      const remaining = (recipe.durationMs ?? 20000) - (Date.now() - started);
      if (remaining > 0) await page.waitForTimeout(remaining);
    } finally {
      const video = page.video();
      await context.close();
      videoPath = video ? await video.path() : null;
    }
  } finally {
    await browser.close();
  }
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('no video was recorded');
  return { videoPath, stats, skipped };
}
