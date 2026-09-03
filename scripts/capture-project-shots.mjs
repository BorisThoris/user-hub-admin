#!/usr/bin/env node
// Photographs this project into ./project-media, using the capture recipe in
// ./project-meta.config.mjs - this project's own route, ready selector, warm-up
// clicks and elements to hide.
//
// Profiles: card (1600x900), desktop (1440x900), mobile (430x932), full (full
// page) and og (1200x630, the image a chat or social card shows when someone
// pastes the deployment link).
//
// Usage:
//   npm run shots                      # capture from the deployment when there is one
//   npm run shots -- --source=local     # start the dev server and capture that
//   npm run shots -- --profiles=og,card
//   npm run shots -- --url=https://...  # capture an explicit URL
//
// Playwright is resolved from this repo if it has one, otherwise from the
// portfolio checkout (PORTFOLIO_ROOT), so a project needs no new dependency.
//
// Installed by the portfolio meta toolkit; edit the template there.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import config from './project-meta.config.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const outputDir = path.join(repoRoot, valueOf('--out') ?? 'project-media');

const PROFILES = {
  card: { width: 1600, height: 900, quality: 90 },
  desktop: { width: 1440, height: 900, quality: 90 },
  mobile: { width: 430, height: 932, quality: 88, isMobile: true, hasTouch: true },
  full: { width: 1440, height: 900, quality: 86, fullPage: true },
  og: { width: 1200, height: 630, quality: 92 }
};

const requested = (valueOf('--profiles') ?? Object.keys(PROFILES).join(',')).split(',').map((name) => name.trim());
const unknown = requested.filter((name) => !PROFILES[name]);
if (unknown.length > 0) {
  console.error('[shots] unknown profile(s): ' + unknown.join(', ') + '. Known: ' + Object.keys(PROFILES).join(', '));
  process.exit(2);
}

const capture = config.capture ?? {};
const route = capture.route ?? '/';
const explicitUrl = valueOf('--url');
const source = valueOf('--source') ?? (explicitUrl ? 'explicit' : (config.curated?.deploymentUrl ? 'deployment' : 'local'));

const chromium = await loadChromium();
let server;
let baseUrl;

try {
  if (source === 'explicit') {
    baseUrl = explicitUrl;
  } else if (source === 'deployment') {
    baseUrl = config.curated?.deploymentUrl;
    if (!baseUrl) {
      console.error('[shots] this project has no deploymentUrl; use --source=local or --url=...');
      process.exit(2);
    }
  } else {
    server = await startLocalServer();
    baseUrl = server.url;
  }

  const target = joinUrl(baseUrl, route);
  console.log('[shots] ' + config.slug + ': capturing ' + target + ' (' + source + ')');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const name of requested) {
      const profile = PROFILES[name];
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: 1,
        isMobile: profile.isMobile ?? false,
        hasTouch: profile.hasTouch ?? false,
        colorScheme: capture.colorScheme ?? 'dark'
      });
      const page = await context.newPage();

      try {
        await page.goto(target, { waitUntil: 'load', timeout: 45000 });
        await settle(page);
        const file = path.join(outputDir, name + '.jpg');
        await page.screenshot({
          path: file,
          type: 'jpeg',
          quality: profile.quality,
          fullPage: profile.fullPage ?? false
        });
        const bytes = fs.statSync(file).size;
        results.push({ profile: name, file: path.basename(file), width: profile.width, height: profile.height, bytes, status: 'captured' });
        console.log('[shots]   ' + name.padEnd(8) + ' ' + profile.width + 'x' + profile.height + '  ' + Math.round(bytes / 1024) + ' KB');
      } catch (error) {
        results.push({ profile: name, status: 'failed', error: String(error.message).split('\n')[0] });
        console.error('[shots]   ' + name.padEnd(8) + ' FAILED: ' + String(error.message).split('\n')[0]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const manifest = {
    slug: config.slug,
    capturedAt: new Date().toISOString(),
    source,
    url: target,
    recipe: capture,
    profiles: results
  };
  fs.writeFileSync(path.join(outputDir, 'capture.json'), JSON.stringify(manifest, null, 2) + '\n');

  const failed = results.filter((entry) => entry.status !== 'captured');
  console.log('[shots] ' + config.slug + ': ' + (results.length - failed.length) + '/' + results.length +
    ' profiles into ' + path.relative(repoRoot, outputDir) + '/');
  if (failed.length > 0) process.exitCode = 1;
} finally {
  if (server) await server.stop();
}

// ------------------------------------------------------------------ capture

async function settle(page) {
  if (capture.readySelector) {
    try {
      await page.waitForSelector(capture.readySelector, {
        state: capture.readyState ?? 'attached',
        timeout: capture.readyTimeoutMs ?? 20000
      });
    } catch {
      console.warn('[shots]   ready selector never appeared: ' + capture.readySelector);
    }
  }

  for (const action of capture.actions ?? []) {
    try {
      const locator = locatorFor(page, action.target);
      if (action.type === 'click') await locator.click({ timeout: action.timeoutMs ?? 15000 });
      else if (action.type === 'waitFor') await locator.waitFor({ state: action.state ?? 'visible', timeout: action.timeoutMs ?? 15000 });
      else if (action.type === 'wait') await page.waitForTimeout(action.ms ?? 500);
    } catch (error) {
      console.warn('[shots]   action skipped (' + (action.label ?? action.type) + '): ' + String(error.message).split('\n')[0]);
    }
  }

  for (const selector of capture.hideSelectors ?? []) {
    await page.addStyleTag({ content: selector + ' { visibility: hidden !important; }' }).catch(() => {});
  }

  await page.waitForTimeout(capture.waitAfterReadyMs ?? 1200);
}

function locatorFor(page, target) {
  if (!target) throw new Error('action has no target');
  if (target.role) return page.getByRole(target.role, { name: target.name, exact: target.exact ?? false });
  if (target.text) return page.getByText(target.text, { exact: target.exact ?? false });
  return page.locator(target.selector ?? target);
}

// ------------------------------------------------------------------ runtime

async function startLocalServer() {
  const command = config.curated?.runCommand;
  if (!command) throw new Error('no runCommand in project-meta.config.mjs; use --url=... instead');
  const url = config.curated?.localUrl ?? 'http://127.0.0.1:' + (config.curated?.devPort ?? 5173) + '/';
  const cwd = config.curated?.runCwd ? path.join(repoRoot, config.curated.runCwd) : repoRoot;

  console.log('[shots] starting: ' + command);
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await probe(url)) {
      return { url, stop: () => stopProcess(child) };
    }
    await delay(1000);
  }
  await stopProcess(child);
  throw new Error('dev server did not answer at ' + url + ' within 120s');
}

async function probe(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    return response.ok || response.status === 304;
  } catch {
    return false;
  }
}

async function stopProcess(child) {
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

// ------------------------------------------------------------------ helpers

async function loadChromium() {
  const candidates = [repoRoot];
  const portfolioRoot = config.media?.sourceDir ? path.resolve(config.media.sourceDir, '..', '..', '..', '..') : null;
  if (process.env.PORTFOLIO_ROOT) candidates.push(process.env.PORTFOLIO_ROOT);
  if (portfolioRoot) candidates.push(portfolioRoot);

  for (const base of candidates) {
    for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
      try {
        const require_ = createRequire(path.join(base, 'package.json'));
        const resolved = require_.resolve(name);
        const module_ = await import(pathToFileURL(resolved).href);
        // These packages are CommonJS, so the named export may only exist on default.
        const chromium_ = module_.chromium ?? module_.default?.chromium;
        if (chromium_) return chromium_;
      } catch {
        // try the next candidate
      }
    }
  }
  console.error('[shots] Playwright not found. Install it here (npm i -D @playwright/test && npx playwright install chromium)');
  console.error('        or set PORTFOLIO_ROOT to a checkout that has it.');
  process.exit(2);
}

function joinUrl(base, suffix) {
  if (!suffix || suffix === '/') return base;
  if (suffix.startsWith('#') || suffix.startsWith('/#')) {
    return base.replace(/\/$/, '') + '/' + suffix.replace(/^\//, '');
  }
  return base.replace(/\/$/, '') + '/' + suffix.replace(/^\//, '');
}

function valueOf(flag) {
  const match = process.argv.slice(2).find((argument) => argument.startsWith(flag + '='));
  return match ? match.slice(flag.length + 1) : undefined;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
