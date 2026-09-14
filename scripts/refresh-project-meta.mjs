#!/usr/bin/env node
// One command to bring everything this project publishes about itself up to
// date for a release: new screenshots, the link-preview card, the icon set and
// project.meta.json, in that order.
//
// Usage:
//   npm run meta:refresh                    # photograph the deployment, then refresh everything
//   npm run meta:refresh -- --no-shots      # keep the current screenshots
//   npm run meta:refresh -- --source=local  # photograph the dev server instead
//   npm run meta:refresh -- --check         # verify only; non-zero exit on drift
//
// Each step is its own script (shots, social, icons, meta) and can still be run
// alone; this only sequences them and stops at the first failure.
//
// Installed by the portfolio meta toolkit; edit the template there.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const skipShots = args.includes('--no-shots');
const shotArgs = args.filter((argument) =>
  argument.startsWith('--source=') || argument.startsWith('--url=') || argument.startsWith('--profiles='));

const steps = [];
if (!checkOnly && !skipShots) steps.push({ label: 'shots', script: 'capture-project-shots.mjs', args: shotArgs });
steps.push({ label: 'social', script: 'generate-social-preview.mjs', args: checkOnly ? ['--check'] : [] });
steps.push({ label: 'icons', script: 'generate-app-icons.mjs', args: checkOnly ? ['--check'] : [] });
steps.push({ label: 'meta', script: 'generate-project-meta.mjs', args: checkOnly ? ['--check'] : [] });

for (const step of steps) {
  console.log('\n[refresh] ' + step.label + (step.args.length > 0 ? ' ' + step.args.join(' ') : ''));
  const run = spawnSync(process.execPath, [path.join(scriptDir, step.script), ...step.args], { stdio: 'inherit' });
  if (run.status !== 0) {
    console.error('\n[refresh] stopped: ' + step.label + ' exited with ' + run.status);
    process.exit(run.status ?? 1);
  }
}
console.log('\n[refresh] ' + (checkOnly ? 'everything is up to date.' : 'done.'));
