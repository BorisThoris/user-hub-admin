#!/usr/bin/env node
// Rebuilds this project's rendered media - its trailers and rendered posters -
// whenever the sources they are rendered from change, publishes a web-sized
// copy of each trailer into the site's static directory and records what was
// built in project-media/trailers.json (which project.meta.json then carries).
//
// Usage:
//   npm run trailers                  # rebuild whatever is stale, publish, record
//   npm run trailers -- --check       # non-zero exit if anything is stale or unpublished
//   npm run trailers -- --check --buildable-only   # ...ignoring items this machine cannot render
//   npm run trailers -- --force       # rebuild everything
//   npm run trailers -- --only=<id>   # one item
//   npm run trailers -- --list        # what is configured and its state
//   npm run trailers -- --no-build    # publish and record what the build already produced
//                                     #   (a render finished by hand after a crash)
//
// The `trailers` block of ./project-meta.config.mjs describes the items:
//
//   trailers: {
//     dir: 'app/public/trailers',    // where the web copies are published (default: <social.staticDir>/trailers)
//     urlPathPrefix: '/trailers',    // that directory's URL on the deployment
//     maxBytes: 20 * 1024 * 1024,    // size cap for a web copy (Cloudflare serves single files up to 25 MiB)
//     items: [{
//       id: 'showcase-bg',           // file name of the web copy: <dir>/<id>.mp4 + <id>.jpg
//       title: 'Showcase trailer',
//       kind: 'trailer',             // 'trailer': a video to publish; 'stills': a build that writes
//                                    //   its own images (a poster set into project-media/);
//                                    //   'artwork': one still to publish (a wallpaper, poster, key art)
//       inputs: ['marketing/instagram-trailer', 'app/src'],   // git pathspecs; a change here rebuilds
//       prepare: { command: 'node marketing/instagram-trailer/regenerate.mjs --only screens',
//                  inputs: ['app/src', 'src'] },   // optional generator step with its own inputs
//       build: 'node marketing/instagram-trailer/build.mjs',   // writes `output`
//       output: 'output/trailer/showcase/bg/vyb-chess-showcase-bg.mp4',
//       requires: ['ffmpeg', { name: 'blender', env: 'BLENDER', candidates: ['E:/.../blender.exe'] }],
//       posterAt: 0.4                // where in the video the poster frame is taken (fraction)
//     }]
//   }
//
// An artwork item publishes one image the way a trailer publishes a video:
//
//     artworkDir: 'public/artwork',   // where the web copies go (default: <social.staticDir>/artwork)
//     artworkUrlPathPrefix: '/artwork',
//     items: [{
//       id: 'cover-remember-this',
//       title: 'Remember this',
//       kind: 'artwork',
//       role: 'wallpaper',           // wallpaper | poster | key-art | capsule | social
//       source: 'project-media/reel-cover-remember-this.jpg',   // the master, committed in project-media/
//       inputs: [...]                // defaults to [source]; a rendered master adds `build` + `output` instead
//       maxWidth: 2560               // the web copy is a JPEG no wider/taller than this (default 2560)
//     }]
//
// A captured trailer is recorded from the running app through Playwright (no
// Blender, no scene of its own): the recipe drives the app the way a player
// or a visitor would, a music bed is mixed under it, and it re-records when
// the app's source (`inputs`) or the recipe changes:
//
//     items: [{
//       id: 'tour', title: 'Two minutes in the editor', kind: 'capture',
//       inputs: ['src', 'index.html'],       // the app; the recipe itself is always part of the hash
//       source: 'deployment',                 // or 'local' (start runCommand) - what to record
//       music: 'project-media/music/tour.m4a',   // optional bed, looped and faded under the picture
//       recipe: {
//         route: '/', viewport: { width: 1280, height: 720 }, durationMs: 20000,
//         setup: { readySelector, actions: [...] },     // strict: must be reached (same shape as capture)
//         timeline: [ { type: 'key', key: 'KeyW', holdMs: 1500 }, ... ],   // what happens on camera
//         quality: { minStd: 10 }                        // the frame mid-way must pass this
//       }
//     }]
//
// An input change is detected through git (the index plus the working tree),
// so a rebuild happens exactly when something the render depends on changed.
// A machine without the toolchain (`requires`) reports the item stale and
// skips it; the render runs where the tools are (the PC's CI chain).
//
// Installed by the portfolio meta toolkit; edit the template there.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import config from './project-meta.config.mjs';
import { assessFrame, loadChromium, recordRecipe, resolveBaseUrl } from './project-media-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');
const listOnly = args.includes('--list');
const noBuild = args.includes('--no-build');
// --check --buildable-only: a stale item whose toolchain (Blender, NVENC) is
// not on this machine is a warning, not a failure - it is rebuilt where it is.
const buildableOnly = args.includes('--buildable-only');
const onlyArg = args.find((argument) => argument.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((value) => value.trim())) : null;

const slug = config.slug;
const trailers = config.trailers ?? {};
const items = (trailers.items ?? []).filter((item) => !only || only.has(item.id));
const recordPath = path.join(repoRoot, 'project-media', 'trailers.json');
const record = readJson(recordPath) ?? { schemaVersion: 1, items: [] };
const recorded = new Map((record.items ?? []).map((item) => [item.id, item]));

if (items.length === 0) {
  console.log('[trailers] ' + slug + ': no trailers configured' + (only ? ' with that id' : '') + '.');
  process.exit(0);
}

const publishDirRelative = toPosix(trailers.dir ?? path.posix.join(config.social?.staticDir ?? 'public', 'trailers'));
const publishDir = path.join(repoRoot, publishDirRelative);
const urlPathPrefix = normalizePrefix(trailers.urlPathPrefix ?? '/trailers');
const maxBytes = trailers.maxBytes ?? 20 * 1024 * 1024;
const artworkDirRelative = toPosix(trailers.artworkDir ?? path.posix.join(config.social?.staticDir ?? 'public', 'artwork'));
const artworkDir = path.join(repoRoot, artworkDirRelative);
const artworkUrlPathPrefix = normalizePrefix(trailers.artworkUrlPathPrefix ?? '/artwork');

const stale = [];
const missingTools = [];
const preparedThisRun = new Set();
let built = 0;
let recordChanged = false;

for (const item of items) {
  const previous = recorded.get(item.id);
  const state = describeState(item, previous);

  if (listOnly) {
    console.log('[trailers] ' + item.id.padEnd(16) + ' ' + (item.kind ?? 'trailer').padEnd(8) + ' ' + state.summary);
    continue;
  }

  if (checkOnly) {
    if (state.stale && buildableOnly && checkRequirements(item.requires ?? []).missing.length > 0) {
      console.warn('[trailers] ' + item.id + ': stale (' + state.reason + ') but needs ' + checkRequirements(item.requires ?? []).missing.join(', ') + ' - rebuilt where the toolchain is.');
    } else if (state.stale) stale.push(item.id + ' (' + state.reason + ')');
    else console.log('[trailers] ' + item.id + ': current' + (previous?.builtAt ? ' (built ' + previous.builtAt + ')' : ''));
    continue;
  }

  if (!state.stale && !force) {
    console.log('[trailers] ' + item.id + ': current, nothing to do.');
    continue;
  }

  const tools = checkRequirements(item.requires ?? []);
  if (tools.missing.length > 0) {
    console.warn('[trailers] ' + item.id + ': stale (' + state.reason + ') but this machine has no ' + tools.missing.join(', ') + ' - skipped.');
    missingTools.push(item.id);
    continue;
  }

  let prepareHash = previous?.prepareHash;
  if (item.prepare && (force || state.prepareStale) && !noBuild) {
    // Items sharing a generator (both VYB edits recapture the same screens)
    // run it once per invocation; a second capture could differ by a pixel
    // and make the first item look stale again.
    if (preparedThisRun.has(item.prepare.command)) {
      console.log('[trailers] ' + item.id + ': prepare already ran this time.');
    } else {
      console.log('\n[trailers] ' + item.id + ': prepare - ' + item.prepare.command);
      run(item.prepare.command, tools.env);
      preparedThisRun.add(item.prepare.command);
    }
    prepareHash = hashPathspecs(item.prepare.inputs ?? []);
  }

  // The build hash is taken after prepare so regenerated inputs are part of it.
  const inputsHash = hashPathspecs(itemInputs(item), itemExtraInput(item));
  const needsBuild = force || !previous || previous.inputsHash !== inputsHash || state.unpublished;
  if (!needsBuild) {
    // prepare ran but produced identical inputs: the render is still valid.
    recorded.set(item.id, { ...previous, prepareHash });
    recordChanged = true;
    console.log('[trailers] ' + item.id + ': inputs unchanged after prepare, render kept.');
    continue;
  }

  if (item.kind === 'capture') {
    // recorded and published in one go below
  } else if (noBuild || !item.build) {
    console.log('\n[trailers] ' + item.id + ': ' + (item.build ? '--no-build, ' : '') + 'publishing ' + (item.output ?? item.source ?? 'the build') + '.');
  } else {
    if (trailers.freeGpu) freeGpu();
    console.log('\n[trailers] ' + item.id + ': build - ' + item.build);
    // A render that shares the GPU with another job can lose its encoder pipe
    // once; a second attempt is cheap next to a stale trailer.
    if (!attempt(item.build, tools.env)) {
      console.warn('[trailers] ' + item.id + ': build failed once, retrying.');
      run(item.build, tools.env);
    }
  }

  const entry = { id: item.id, title: item.title ?? item.id, kind: item.kind ?? 'trailer', inputsHash, builtAt: new Date().toISOString() };
  if (item.prepare) entry.prepareHash = prepareHash ?? hashPathspecs(item.prepare.inputs ?? []);
  if ((item.kind ?? 'trailer') === 'trailer') Object.assign(entry, publishTrailer(item));
  else if (item.kind === 'capture') Object.assign(entry, await publishCapture(item));
  else if (item.kind === 'artwork') Object.assign(entry, publishArtwork(item));
  else if (item.outputs) entry.outputs = item.outputs.map((relative) => describeFile(relative));
  recorded.set(item.id, entry);
  recordChanged = true;
  built += 1;
}

if (listOnly) process.exit(0);

if (checkOnly) {
  if (stale.length > 0) {
    console.error('[trailers] ' + slug + ': stale - ' + stale.join('; ') + '. Run: npm run trailers');
    process.exit(1);
  }
  console.log('[trailers] ' + slug + ': all rendered media is current.');
  process.exit(0);
}

if (recordChanged) {
  // Every configured item keeps its record (a --only run touches one); items
  // dropped from the config disappear from the record.
  const next = { schemaVersion: 1, items: (trailers.items ?? []).map((item) => recorded.get(item.id)).filter(Boolean) };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(next, null, 2) + '\n');
}
console.log('\n[trailers] ' + slug + ': ' + built + ' built' + (missingTools.length > 0 ? ', ' + missingTools.length + ' skipped for missing tools' : '') + '.');

// ------------------------------------------------------------------ state

function describeState(item, previous) {
  const kind = item.kind ?? 'trailer';
  const publishes = kind === 'trailer' || kind === 'artwork' || kind === 'capture';
  if (!previous) return { stale: true, reason: 'never built', prepareStale: true, unpublished: publishes, summary: 'never built' };
  const prepareStale = Boolean(item.prepare) && previous.prepareHash !== hashPathspecs(item.prepare.inputs ?? []);
  const inputsStale = previous.inputsHash !== hashPathspecs(itemInputs(item), itemExtraInput(item));
  const unpublished = publishes && !(previous.file && fs.existsSync(path.join(repoRoot, previous.file)));
  const reasons = [];
  if (prepareStale) reasons.push('generator inputs changed');
  if (inputsStale) reasons.push('inputs changed');
  if (unpublished) reasons.push('web copy missing');
  const stale = reasons.length > 0;
  return {
    stale,
    prepareStale,
    unpublished,
    reason: reasons.join(', '),
    summary: stale ? 'STALE: ' + reasons.join(', ') : 'current (built ' + previous.builtAt + (previous.file ? ', ' + previous.file : '') + ')'
  };
}

// An artwork item with no inputs of its own is rendered from its source file.
// Whatever this toolkit publishes into the static directory (trailers,
// artwork, the card image, the icon set) is never an input, or a build would
// invalidate itself.
function itemInputs(item) {
  let inputs = [];
  if (Array.isArray(item.inputs)) inputs = item.inputs;
  else if (item.kind === 'artwork' && item.source) inputs = [item.source];
  if (inputs.length === 0) return inputs;
  const staticDir = toPosix(config.social?.staticDir ?? 'public');
  const iconDir = toPosix(config.icons?.outputDir ?? staticDir);
  const generated = [
    publishDirRelative, artworkDirRelative,
    path.posix.join(staticDir, config.social?.imageName ?? 'og-image.jpg'),
    ...['favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', config.icons?.manifestName ?? 'site.webmanifest']
      .map((name) => path.posix.join(iconDir, name))
  ];
  return [...inputs, ...generated.map((relative) => ':(exclude)' + relative)];
}

// A captured trailer is also a function of its recipe and its music bed.
function itemExtraInput(item) {
  if (item.kind !== 'capture') return '';
  return JSON.stringify({ recipe: item.recipe ?? null, music: item.music ?? null, source: item.source ?? 'deployment' });
}

// The hash covers every tracked file under the pathspecs (its blob id from the
// index) plus the content of anything modified or untracked in the working
// tree, so an unstaged edit counts as a change too. Ignored files do not.
function hashPathspecs(pathspecs, extra = '') {
  if (pathspecs.length === 0 && !extra) return 'none';
  const hash = crypto.createHash('sha256');
  hash.update(extra);
  if (pathspecs.length === 0) return hash.digest('hex');
  const listed = git(['ls-files', '-s', '-z', '--', ...pathspecs]);
  hash.update(listed);
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...pathspecs]);
  for (const line of status.split('\0')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    hash.update('\n' + code + ' ' + file + ' ');
    const full = path.join(repoRoot, file);
    if (code.includes('D') || !fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) continue;
    hash.update(crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return hash.digest('hex');
}

function git(gitArgs) {
  const run = spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error('git ' + gitArgs.slice(0, 2).join(' ') + ' failed: ' + (run.stderr || '').trim());
  return run.stdout;
}

// ------------------------------------------------------------------ tools

// A requirement is a command on PATH ('ffmpeg', 'py') or an object naming an
// environment variable and known install locations; the resolved path is
// exported under that variable for the build.
function checkRequirements(requires) {
  const missing = [];
  const env = { ...process.env };
  for (const requirement of requires) {
    const spec = typeof requirement === 'string' ? { name: requirement } : requirement;
    const envValue = spec.env ? process.env[spec.env] : undefined;
    const candidates = [envValue, ...(spec.candidates ?? [])].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) {
      if (spec.env) env[spec.env] = found;
      continue;
    }
    if (candidates.length === 0 || spec.onPath) {
      if (onPath(spec.name)) continue;
    }
    missing.push(spec.name);
  }
  return { missing, env };
}

function onPath(name) {
  let probe = spawnSync(name, ['--version'], { encoding: 'utf8', windowsHide: true });
  // A .cmd shim on Windows (npm, npx) only resolves through the shell.
  if (probe.error && process.platform === 'win32') probe = spawnSync(name + ' --version', { encoding: 'utf8', shell: true, windowsHide: true });
  if (probe.error) return false;
  // Some tools answer --version on stderr or with a non-zero status; a spawn
  // that produced any output means the executable exists.
  return probe.status === 0 || Boolean((probe.stdout || '').trim() || (probe.stderr || '').trim());
}

// trailers.freeGpu: a render shares the card with the local LLM on this PC
// (Ollama keeps a 20 GB model resident for ten minutes after a request), and
// Blender dies with "LLVM ERROR: out of memory" next to it. Unload whatever
// Ollama holds before rendering; it reloads on the next request.
function freeGpu() {
  const listed = spawnSync('ollama', ['ps'], { encoding: 'utf8', windowsHide: true });
  if (listed.error || listed.status !== 0) return;
  const models = listed.stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  for (const model of models) {
    console.log('[trailers] unloading ' + model + ' from the GPU (ollama stop)');
    spawnSync('ollama', ['stop', model], { stdio: 'ignore', windowsHide: true });
  }
}

function attempt(command, env) {
  const result = spawnSync(command, { cwd: repoRoot, stdio: 'inherit', shell: true, env });
  return result.status === 0;
}

function run(command, env) {
  const result = spawnSync(command, { cwd: repoRoot, stdio: 'inherit', shell: true, env });
  if (result.status !== 0) {
    console.error('[trailers] ' + slug + ': command failed (' + result.status + '): ' + command);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ publishing

// The master is whatever the build wrote; the site gets an H.264 + AAC copy
// with faststart that any browser plays inline, capped in size, and a poster
// frame beside it.
function publishTrailer(item) {
  const source = path.join(repoRoot, item.output);
  if (!fs.existsSync(source)) {
    console.error('[trailers] ' + item.id + ': the build did not produce ' + item.output);
    process.exit(1);
  }
  fs.mkdirSync(publishDir, { recursive: true });
  const target = path.join(publishDir, item.id + '.mp4');
  const poster = path.join(publishDir, item.id + '.jpg');
  const info = probe(source);

  let crf = item.crf ?? 23;
  encode(source, target, { crf, maxHeight: item.maxHeight ?? 1920 });
  let bytes = fs.statSync(target).size;
  if (bytes > maxBytes) {
    // Too big at that quality: fit a bitrate to the cap instead.
    const kbps = Math.max(600, Math.floor(((maxBytes * 8 * 0.94) / info.duration - 128000) / 1000));
    console.log('[trailers] ' + item.id + ': ' + formatBytes(bytes) + ' exceeds the cap, re-encoding at ' + kbps + ' kbps');
    encode(source, target, { kbps, maxHeight: item.maxHeight ?? 1920 });
    bytes = fs.statSync(target).size;
  }
  const published = probe(target);
  const at = Math.max(0, Math.min(published.duration - 0.1, (item.posterAt ?? 0.4) * published.duration));
  ffmpeg(['-y', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', target, '-frames:v', '1', '-q:v', '3', poster]);

  console.log('[trailers] ' + item.id + ': published ' + toPosix(path.relative(repoRoot, target)) + ' (' + formatBytes(bytes) + ', ' +
    published.width + 'x' + published.height + ', ' + published.duration.toFixed(1) + ' s) + poster');

  return {
    source: toPosix(item.output),
    file: toPosix(path.relative(repoRoot, target)),
    poster: toPosix(path.relative(repoRoot, poster)),
    urlPath: urlPathPrefix + item.id + '.mp4',
    posterUrlPath: urlPathPrefix + item.id + '.jpg',
    bytes,
    width: published.width,
    height: published.height,
    duration: Number(published.duration.toFixed(2)),
    fps: published.fps,
    orientation: item.orientation ?? (published.height > published.width ? 'portrait' : published.height === published.width ? 'square' : 'landscape')
  };
}

// Records the recipe from the running app (Playwright's webm), keeps that
// master under project-media/.captures/ (ignored), then publishes it like any
// trailer: H.264 + AAC with the music bed looped and faded underneath, capped
// in size, with a poster frame. --no-build re-encodes the last recording.
async function publishCapture(item) {
  const recipe = item.recipe ?? {};
  const capturesDir = path.join(repoRoot, 'project-media', '.captures');
  const master = path.join(capturesDir, item.id + '.webm');
  fs.mkdirSync(capturesDir, { recursive: true });
  let stats = null;

  if (noBuild && fs.existsSync(master)) {
    console.log('\n[trailers] ' + item.id + ': --no-build, re-publishing the last recording.');
  } else {
    const chromium = await loadChromium(repoRoot, config);
    const base = await resolveBaseUrl(config, repoRoot, { source: item.source ?? 'deployment', url: item.url, log: (line) => console.log(line.replace('[media]', '[trailers]')) });
    try {
      console.log('\n[trailers] ' + item.id + ': recording ' + (recipe.durationMs ?? 20000) / 1000 + ' s of ' + base.url + ' (' + base.source + ')');
      const recording = await recordRecipe(chromium, { url: base.url, recipe, outDir: capturesDir, log: (line) => console.log(line.replace('[media]', '[trailers]')) });
      stats = recording.stats;
      const problems = assessFrame(stats, recipe.quality);
      if (problems.length > 0) {
        fs.rmSync(recording.videoPath, { force: true });
        console.error('[trailers] ' + item.id + ': the recording does not show the app - ' + problems.join('; '));
        process.exit(1);
      }
      fs.renameSync(recording.videoPath, master);
      if (recording.skipped.length > 0) console.log('[trailers] ' + item.id + ': skipped ' + recording.skipped.length + ' optional step(s)');
    } finally {
      await base.stop();
    }
  }

  fs.mkdirSync(publishDir, { recursive: true });
  const target = path.join(publishDir, item.id + '.mp4');
  const poster = path.join(publishDir, item.id + '.jpg');
  const music = item.music ? path.join(repoRoot, item.music) : null;
  if (music && !fs.existsSync(music)) {
    console.error('[trailers] ' + item.id + ': music bed ' + item.music + ' does not exist');
    process.exit(1);
  }
  const duration = Math.max(1, (recipe.durationMs ?? 20000) / 1000);
  encodeCapture(master, target, { music, duration, crf: item.crf ?? 23, maxHeight: item.maxHeight ?? 1080 });
  let bytes = fs.statSync(target).size;
  if (bytes > maxBytes) {
    const kbps = Math.max(600, Math.floor(((maxBytes * 8 * 0.94) / duration - 128000) / 1000));
    console.log('[trailers] ' + item.id + ': ' + formatBytes(bytes) + ' exceeds the cap, re-encoding at ' + kbps + ' kbps');
    encodeCapture(master, target, { music, duration, kbps, maxHeight: item.maxHeight ?? 1080 });
    bytes = fs.statSync(target).size;
  }
  const published = probe(target);
  const at = Math.max(0, Math.min(published.duration - 0.1, (item.posterAt ?? 0.5) * published.duration));
  ffmpeg(['-y', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', target, '-frames:v', '1', '-q:v', '3', poster]);
  console.log('[trailers] ' + item.id + ': published ' + toPosix(path.relative(repoRoot, target)) + ' (' + formatBytes(bytes) + ', ' +
    published.width + 'x' + published.height + ', ' + published.duration.toFixed(1) + ' s) + poster');

  return {
    source: toPosix(path.relative(repoRoot, master)),
    file: toPosix(path.relative(repoRoot, target)),
    poster: toPosix(path.relative(repoRoot, poster)),
    urlPath: urlPathPrefix + item.id + '.mp4',
    posterUrlPath: urlPathPrefix + item.id + '.jpg',
    bytes,
    width: published.width,
    height: published.height,
    duration: Number(published.duration.toFixed(2)),
    fps: published.fps,
    orientation: published.height > published.width ? 'portrait' : published.height === published.width ? 'square' : 'landscape',
    music: item.music,
    stats
  };
}

function encodeCapture(source, target, options) {
  const rate = options.kbps
    ? ['-b:v', options.kbps + 'k', '-maxrate', options.kbps + 'k', '-bufsize', options.kbps * 2 + 'k']
    : ['-crf', String(options.crf)];
  const scale = "scale='min(iw,1920)':'min(ih," + options.maxHeight + ")':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const fadeOut = Math.max(0, options.duration - 2).toFixed(2);
  const audio = options.music
    ? ['-stream_loop', '-1', '-i', options.music,
      '-filter_complex', '[0:v]' + scale + ',fps=30[v];[1:a]afade=t=in:d=1,afade=t=out:st=' + fadeOut + ':d=2,volume=0.9[a]',
      '-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
    : ['-vf', scale + ',fps=30', '-an'];
  ffmpeg([
    '-y', '-loglevel', 'error', '-i', source, ...audio,
    '-t', options.duration.toFixed(2),
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...rate,
    '-movflags', '+faststart', target
  ]);
}

// A still is published as a JPEG the site can serve at any size: the master
// (a PNG, a large JPEG) stays in project-media/, the web copy lands in
// artworkDir under the item's id, capped at maxWidth on its long side.
function publishArtwork(item) {
  const relative = item.output ?? item.source;
  if (!relative) {
    console.error('[trailers] ' + item.id + ': an artwork item needs a `source` (or a `build` with an `output`)');
    process.exit(1);
  }
  const source = path.join(repoRoot, relative);
  if (!fs.existsSync(source)) {
    console.error('[trailers] ' + item.id + ': ' + relative + ' does not exist');
    process.exit(1);
  }
  fs.mkdirSync(artworkDir, { recursive: true });
  const target = path.join(artworkDir, item.id + '.jpg');
  const cap = item.maxWidth ?? 2560;
  ffmpeg([
    '-y', '-loglevel', 'error', '-i', source,
    '-vf', "scale='min(iw," + cap + ")':'min(ih," + cap + ")':force_original_aspect_ratio=decrease",
    '-q:v', String(item.quality ?? 3), '-frames:v', '1', target
  ]);
  const published = probe(target);
  const bytes = fs.statSync(target).size;
  console.log('[trailers] ' + item.id + ': published ' + toPosix(path.relative(repoRoot, target)) + ' (' + formatBytes(bytes) + ', ' +
    published.width + 'x' + published.height + ')');
  return {
    role: item.role ?? 'artwork',
    source: toPosix(relative),
    file: toPosix(path.relative(repoRoot, target)),
    urlPath: artworkUrlPathPrefix + item.id + '.jpg',
    bytes,
    width: published.width,
    height: published.height,
    orientation: published.height > published.width ? 'portrait' : published.height === published.width ? 'square' : 'landscape'
  };
}

function encode(source, target, options) {
  const rate = options.kbps
    ? ['-b:v', options.kbps + 'k', '-maxrate', options.kbps + 'k', '-bufsize', options.kbps * 2 + 'k']
    : ['-crf', String(options.crf)];
  ffmpeg([
    '-y', '-loglevel', 'error', '-i', source,
    '-vf', "scale='min(iw,1920)':'min(ih," + options.maxHeight + ")':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...rate,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', target
  ]);
}

function ffmpeg(ffArgs) {
  const result = spawnSync('ffmpeg', ffArgs, { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('[trailers] ffmpeg failed' + (result.error ? ': ' + result.error.message : ' (' + result.status + ')'));
    process.exit(1);
  }
}

function probe(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'json', file
  ], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('[trailers] ffprobe failed on ' + file + (result.error ? ': ' + result.error.message : ''));
    process.exit(1);
  }
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.[0] ?? {};
  const [num, den] = String(stream.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    duration: Number(parsed.format?.duration ?? 0),
    fps: den ? Number((num / den).toFixed(2)) : undefined
  };
}

function describeFile(relative) {
  const full = path.join(repoRoot, relative);
  return { file: toPosix(relative), bytes: fs.existsSync(full) ? fs.statSync(full).size : 0 };
}

// ------------------------------------------------------------------ helpers

function normalizePrefix(prefix) {
  let value = String(prefix || '/');
  if (!value.startsWith('/')) value = '/' + value;
  if (!value.endsWith('/')) value += '/';
  return value;
}

function formatBytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function toPosix(value) {
  return String(value).split(path.sep).join('/').replace(/\\/g, '/');
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
