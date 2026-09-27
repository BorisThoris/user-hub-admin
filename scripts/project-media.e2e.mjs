#!/usr/bin/env node
// The media contract of this project, end to end: the screenshot recipe and
// every captured-trailer recipe are driven through a real browser against
// the app and must reach the state they describe with a frame that shows the
// app. Nothing is written; this only proves the recipes still work, which is
// what gates a refresh (the refresh workflow runs it against the deployment
// before it photographs anything).
//
//   npm run test:media:e2e                  # against the deployment
//   npm run test:media:e2e -- --source=local # start the dev server first
//   npm run test:media:e2e -- --url=http://127.0.0.1:4173/
//   npm run test:media:e2e -- --only=shots | --only=trailers
//
// Exit code: 0 when every recipe passed, 1 otherwise. Playwright is resolved
// from this repo or from PORTFOLIO_ROOT.
//
// Installed by the portfolio meta toolkit; edit the template there.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './project-meta.config.mjs';
import { PROFILES, assessFrame, frameStats, joinUrl, loadChromium, resolveBaseUrl, runActions, settle } from './project-media-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const only = valueOf('--only');
const log = (line) => console.log(line.replace('[media]', '[media-e2e]'));

const checks = [];
if (!config.capture?.skip && only !== 'trailers') {
  checks.push({
    name: 'screenshot recipe (card viewport)',
    viewport: { width: PROFILES.card.width, height: PROFILES.card.height },
    route: config.capture?.route ?? '/',
    run: async (page) => {
      await settle(page, config.capture ?? {}, { strict: true, log });
      return assessFrame(await frameStats(page), config.capture?.quality);
    }
  });
  checks.push({
    name: 'screenshot recipe (phone viewport)',
    viewport: { width: PROFILES.mobile.width, height: PROFILES.mobile.height },
    mobile: true,
    route: config.capture?.route ?? '/',
    run: async (page) => {
      await settle(page, config.capture ?? {}, { strict: true, log });
      return assessFrame(await frameStats(page), config.capture?.quality);
    }
  });
}
if (only !== 'shots') {
  for (const item of config.trailers?.items ?? []) {
    if (item.kind !== 'capture') continue;
    const recipe = item.recipe ?? {};
    checks.push({
      name: 'trailer recipe ' + item.id,
      viewport: recipe.viewport ?? { width: 1280, height: 720 },
      route: recipe.route ?? '/',
      source: item.source,
      run: async (page) => {
        await settle(page, recipe.setup ?? recipe, { strict: true, log });
        // The timeline is exercised at speed: the point is that its steps
        // resolve, not the pacing.
        await runActions(page, (recipe.timeline ?? []).map((action) => ({ ...action, holdMs: Math.min(action.holdMs ?? 0, 300), ms: Math.min(action.ms ?? 0, 300) })), { strict: false, log });
        return assessFrame(await frameStats(page), recipe.quality);
      }
    });
  }
}

if (checks.length === 0) {
  console.log('[media-e2e] ' + config.slug + ': nothing to drive (no screenshot recipe, no captured trailers).');
  process.exit(0);
}

const chromium = await loadChromium(repoRoot, config).catch((error) => {
  console.error('[media-e2e] ' + error.message);
  process.exit(2);
});

let failures = 0;
const browser = await chromium.launch({ headless: true, args: config.capture?.browserArgs ?? [] });
try {
  for (const check of checks) {
    const base = await resolveBaseUrl(config, repoRoot, { source: valueOf('--source') ?? check.source, url: valueOf('--url'), log });
    const context = await browser.newContext({
      viewport: check.viewport,
      deviceScaleFactor: 1,
      isMobile: check.mobile ?? false,
      hasTouch: check.mobile ?? false,
      colorScheme: config.capture?.colorScheme ?? 'dark'
    });
    const page = await context.newPage();
    const started = Date.now();
    try {
      await page.goto(joinUrl(base.url, check.route), { waitUntil: 'load', timeout: 60000 });
      const problems = await check.run(page);
      if (problems.length > 0) throw new Error('frame rejected: ' + problems.join('; '));
      console.log('[media-e2e] ok    ' + check.name + ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
    } catch (error) {
      failures += 1;
      console.error('[media-e2e] FAIL  ' + check.name + ': ' + String(error.message).split('\n')[0]);
    } finally {
      await context.close();
      await base.stop();
    }
  }
} finally {
  await browser.close();
}

console.log('[media-e2e] ' + config.slug + ': ' + (checks.length - failures) + '/' + checks.length + ' recipes passed.');
process.exit(failures === 0 ? 0 : 1);

function valueOf(flag) {
  const argument = process.argv.find((value) => value.startsWith(flag + '='));
  return argument ? argument.slice(flag.length + 1) : undefined;
}
