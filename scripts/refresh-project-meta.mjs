#!/usr/bin/env node
// One command to bring everything this project publishes about itself up to
// date for a release: rendered media (trailers, posters) when their sources
// changed, new screenshots, the link-preview card, the icon set and
// project.meta.json, in that order.
//
// Usage:
//   npm run meta:refresh                    # rebuild stale trailers, photograph the deployment, refresh everything
//   npm run meta:refresh -- --no-shots      # keep the current screenshots
//   npm run meta:refresh -- --no-trailers   # leave the rendered media alone (a machine without the toolchain)
//   npm run meta:refresh -- --source=local  # photograph the dev server instead
//   npm run meta:refresh -- --check         # verify only; non-zero exit on drift
//   npm run meta:refresh -- --check --warn-meta
//       # what the pre-push hook and CI run: the card and icons must be current,
//       # a stale project.meta.json only warns (its source counts move with
//       # every commit, so it is refreshed on release, not on every push);
//       # stale trailers only warn too, unless --strict-trailers
//   npm run meta:refresh -- --commit --branch=main
//       # what the PC's CI chain runs after a build: everything above, then the
//       # files this toolkit owns are committed as "[meta-bot]" and pushed to
//       # that branch - only when the checkout is on it and not behind origin
//
// Each step is its own script (trailers, shots, social, icons, meta) and can
// still be run alone; this only sequences them and stops at the first failure.
//
// Installed by the portfolio meta toolkit; edit the template there.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import config from './project-meta.config.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const skipShots = args.includes('--no-shots');
const skipTrailers = args.includes('--no-trailers');
const warnMeta = args.includes('--warn-meta');
const strictTrailers = args.includes('--strict-trailers');
const commit = args.includes('--commit');
const branchArg = args.find((argument) => argument.startsWith('--branch='));
const branch = branchArg ? branchArg.slice('--branch='.length) : null;
const shotArgs = args.filter((argument) =>
  argument.startsWith('--source=') || argument.startsWith('--url=') || argument.startsWith('--profiles='));

const hasTrailers = Array.isArray(config.trailers?.items) && config.trailers.items.length > 0;
const shotsSkippedByConfig = Boolean(config.capture?.skip);

const steps = [];
if (hasTrailers && !skipTrailers) {
  steps.push({ label: 'trailers', script: 'build-project-trailers.mjs', args: checkOnly ? ['--check'] : [], warnOnly: checkOnly && !strictTrailers });
}
if (!checkOnly && !skipShots && !shotsSkippedByConfig) steps.push({ label: 'shots', script: 'capture-project-shots.mjs', args: shotArgs });
steps.push({ label: 'social', script: 'generate-social-preview.mjs', args: checkOnly ? ['--check'] : [] });
steps.push({ label: 'icons', script: 'generate-app-icons.mjs', args: checkOnly ? ['--check'] : [] });
steps.push({ label: 'meta', script: 'generate-project-meta.mjs', args: checkOnly ? ['--check'] : [], warnOnly: checkOnly && warnMeta });

let warned = false;
for (const step of steps) {
  console.log('\n[refresh] ' + step.label + (step.args.length > 0 ? ' ' + step.args.join(' ') : ''));
  const run = spawnSync(process.execPath, [path.join(scriptDir, step.script), ...step.args], { stdio: 'inherit' });
  if (run.status !== 0 && step.warnOnly) {
    console.warn('[refresh] warning: ' + step.label + ' is stale (run: npm run ' + (step.label === 'meta' ? 'meta' : step.label) + ') - not blocking.');
    warned = true;
    continue;
  }
  if (run.status !== 0) {
    console.error('\n[refresh] stopped: ' + step.label + ' exited with ' + run.status);
    process.exit(run.status ?? 1);
  }
}

if (checkOnly) {
  console.log('\n[refresh] ' + (warned ? 'card and icons are current; metadata or rendered media want a refresh.' : 'everything is up to date.'));
  process.exit(0);
}

// A repo can keep derived files in step with what was just written (VYB Chess
// registers og-image.jpg in an asset inventory that its validation checks).
for (const command of config.afterRefresh ?? []) {
  console.log('\n[refresh] after: ' + command);
  const run = spawnSync(command, { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (run.status !== 0) {
    console.error('\n[refresh] stopped: "' + command + '" exited with ' + run.status);
    process.exit(run.status ?? 1);
  }
}

if (commit) commitOwnedFiles();
console.log('\n[refresh] done.');

// ------------------------------------------------------------------ commit

// Only the files this toolkit writes are staged, never the whole tree, so a
// working checkout with other work in progress stays untouched.
function commitOwnedFiles() {
  const social = config.social ?? {};
  const icons = config.icons ?? {};
  const staticDir = social.staticDir ?? 'public';
  const iconDir = icons.outputDir ?? staticDir;
  const trailerDir = config.trailers?.dir ?? path.posix.join(staticDir, 'trailers');
  const owned = [
    'project.meta.json',
    'project-media',
    social.htmlFile,
    icons.htmlFile,
    social.staticDir ? path.posix.join(staticDir, social.imageName ?? 'og-image.jpg') : null,
    trailerDir,
    ...['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', icons.manifestName ?? 'site.webmanifest']
      .map((name) => path.posix.join(iconDir, name)),
    ...(config.commitPaths ?? [])
  ].filter(Boolean).filter((relative) => fs.existsSync(path.join(repoRoot, relative)));

  git(['add', '--', ...owned]);
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot });
  if (staged.status === 0) {
    console.log('\n[refresh] nothing changed, nothing to commit.');
    return;
  }
  const changed = git(['diff', '--cached', '--name-only']).trim().split('\n');
  console.log('\n[refresh] committing ' + changed.length + ' file(s):\n  ' + changed.join('\n  '));
  git(['commit', '-q', '-m', 'Refresh trailers, card, icons and metadata [meta-bot]']);

  if (!branch) {
    console.log('[refresh] committed; no --branch given, so nothing was pushed.');
    return;
  }
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== branch) {
    console.warn('[refresh] committed on ' + current + ', not on ' + branch + ' - not pushed.');
    return;
  }
  const fetched = spawnSync('git', ['fetch', '-q', 'origin', branch], { cwd: repoRoot, stdio: 'inherit' });
  if (fetched.status !== 0) {
    console.warn('[refresh] could not reach origin - commit kept locally, not pushed.');
    return;
  }
  const upToDate = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/' + branch, 'HEAD'], { cwd: repoRoot });
  if (upToDate.status !== 0) {
    // Someone pushed while the render ran: replay this one commit on top. A
    // conflict (they touched the same rendered files) is left for the next run.
    const rebased = spawnSync('git', ['rebase', '-q', '--autostash', 'origin/' + branch], { cwd: repoRoot, stdio: 'inherit' });
    if (rebased.status !== 0) {
      spawnSync('git', ['rebase', '--abort'], { cwd: repoRoot, stdio: 'ignore' });
      console.warn('[refresh] this checkout is behind origin/' + branch + ' and the commit does not replay cleanly - kept locally; pull, then push.');
      return;
    }
    console.log('[refresh] replayed the commit on top of origin/' + branch + '.');
  }
  const pushed = spawnSync('git', ['push', '-q', 'origin', 'HEAD:' + branch], { cwd: repoRoot, stdio: 'inherit' });
  if (pushed.status !== 0) {
    console.warn('[refresh] push failed - the commit is kept locally.');
    return;
  }
  console.log('[refresh] pushed to origin/' + branch + '.');
}

function git(gitArgs) {
  const run = spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' });
  if (run.status !== 0) {
    console.error('[refresh] git ' + gitArgs[0] + ' failed: ' + (run.stderr || '').trim());
    process.exit(1);
  }
  return run.stdout;
}
