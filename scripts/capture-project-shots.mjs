#!/usr/bin/env node
// Photographs this project into ./project-media, using the capture recipe in
// ./project-meta.config.mjs - this project's own route, ready selector, warm-up
// clicks and elements to hide - and refuses a picture that is not the app:
// a recipe step that cannot be reached, or a frame that is blank, black or a
// loading screen, fails the profile instead of shipping it.
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
//   npm run shots -- --lenient          # keep going past a failed recipe step (for debugging a recipe)
//
// Every profile's frame statistics and any skipped steps are written to
// project-media/capture.json; scripts/project-media.test.mjs reads them back
// and fails when a picture did not pass. Playwright is resolved from this repo
// if it has one, otherwise from the portfolio checkout (PORTFOLIO_ROOT).
//
// Installed by the portfolio meta toolkit; edit the template there.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './project-meta.config.mjs';
import { PROFILES, assessFrame, frameStats, joinUrl, loadChromium, resolveBaseUrl, settle } from './project-media-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const outputDir = path.join(repoRoot, valueOf('--out') ?? 'project-media');
const lenient = process.argv.includes('--lenient');

const requested = (valueOf('--profiles') ?? Object.keys(PROFILES).join(',')).split(',').map((name) => name.trim());
const unknown = requested.filter((name) => !PROFILES[name]);
if (unknown.length > 0) {
  console.error('[shots] unknown profile(s): ' + unknown.join(', ') + '. Known: ' + Object.keys(PROFILES).join(', '));
  process.exit(2);
}

const capture = config.capture ?? {};
// A project whose pictures are rendered rather than photographed (a poster set
// from its own scene, see build-project-trailers.mjs) opts out here.
if (capture.skip) {
  console.log('[shots] ' + config.slug + ': screenshots are not taken for this project' +
    (typeof capture.skip === 'string' ? ' - ' + capture.skip : '') + '.');
  process.exit(0);
}
const route = capture.route ?? '/';

const chromium = await loadChromium(repoRoot, config).catch((error) => {
  console.error('[shots] ' + error.message);
  process.exit(2);
});

let base;
try {
  base = await resolveBaseUrl(config, repoRoot, { source: valueOf('--source'), url: valueOf('--url'), log: (line) => console.log(line.replace('[media]', '[shots]')) });
} catch (error) {
  console.error('[shots] ' + error.message);
  process.exit(2);
}

try {
  const target = joinUrl(base.url, route);
  console.log('[shots] ' + config.slug + ': capturing ' + target + ' (' + base.source + ')');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: capture.browserArgs ?? [] });
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
        await page.goto(target, { waitUntil: 'load', timeout: capture.loadTimeoutMs ?? 60000 });
        const skipped = await settle(page, capture, { strict: !lenient, log: (line) => console.log(line.replace('[media]', '[shots]')) });
        const stats = await frameStats(page);
        const problems = assessFrame(stats, capture.quality);
        if (problems.length > 0 && !lenient) throw new Error('frame rejected: ' + problems.join('; '));

        const file = path.join(outputDir, name + '.jpg');
        await page.screenshot({ path: file, type: 'jpeg', quality: profile.quality, fullPage: profile.fullPage ?? false });
        const bytes = fs.statSync(file).size;
        results.push({
          profile: name, file: path.basename(file), width: profile.width, height: profile.height, bytes,
          status: 'captured', stats, skipped: skipped.length > 0 ? skipped : undefined, problems: problems.length > 0 ? problems : undefined
        });
        console.log('[shots]   ' + name.padEnd(8) + ' ' + profile.width + 'x' + profile.height + '  ' + Math.round(bytes / 1024) + ' KB' +
          '  (spread ' + stats.std + ', ' + stats.colours + ' colours' + (problems.length > 0 ? '; ' + problems.join('; ') : '') + ')');
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
    source: base.source,
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
  await base.stop();
}

function valueOf(flag) {
  const argument = process.argv.find((value) => value.startsWith(flag + '='));
  return argument ? argument.slice(flag.length + 1) : undefined;
}
