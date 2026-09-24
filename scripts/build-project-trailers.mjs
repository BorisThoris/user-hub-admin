#!/usr/bin/env node
// Rebuilds this project's rendered media - its trailers and rendered posters -
// whenever the sources they are rendered from change, publishes a web-sized
// copy of each trailer into the site's static directory and records what was
// built in project-media/trailers.json (which project.meta.json then carries).
//
// Usage:
//   npm run trailers                  # rebuild whatever is stale, publish, record
//   npm run trailers -- --check       # non-zero exit if anything is stale or unpublished
//   npm run trailers -- --force       # rebuild everything
//   npm run trailers -- --only=<id>   # one item
//   npm run trailers -- --list        # what is configured and its state
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
//                                    //   its own images (a poster set into project-media/)
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');
const listOnly = args.includes('--list');
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

const stale = [];
const missingTools = [];
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
    if (state.stale) stale.push(item.id + ' (' + state.reason + ')');
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
  if (item.prepare && (force || state.prepareStale)) {
    console.log('\n[trailers] ' + item.id + ': prepare - ' + item.prepare.command);
    run(item.prepare.command, tools.env);
    prepareHash = hashPathspecs(item.prepare.inputs ?? []);
  }

  // The build hash is taken after prepare so regenerated inputs are part of it.
  const inputsHash = hashPathspecs(item.inputs ?? []);
  const needsBuild = force || !previous || previous.inputsHash !== inputsHash || state.unpublished;
  if (!needsBuild) {
    // prepare ran but produced identical inputs: the render is still valid.
    recorded.set(item.id, { ...previous, prepareHash });
    recordChanged = true;
    console.log('[trailers] ' + item.id + ': inputs unchanged after prepare, render kept.');
    continue;
  }

  console.log('\n[trailers] ' + item.id + ': build - ' + item.build);
  run(item.build, tools.env);

  const entry = { id: item.id, title: item.title ?? item.id, kind: item.kind ?? 'trailer', inputsHash, builtAt: new Date().toISOString() };
  if (item.prepare) entry.prepareHash = prepareHash ?? hashPathspecs(item.prepare.inputs ?? []);
  if ((item.kind ?? 'trailer') === 'trailer') Object.assign(entry, publishTrailer(item));
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
  const next = { schemaVersion: 1, items: items.map((item) => recorded.get(item.id)).filter(Boolean) };
  // Items that were dropped from the config disappear from the record too.
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(next, null, 2) + '\n');
}
console.log('\n[trailers] ' + slug + ': ' + built + ' built' + (missingTools.length > 0 ? ', ' + missingTools.length + ' skipped for missing tools' : '') + '.');

// ------------------------------------------------------------------ state

function describeState(item, previous) {
  const kind = item.kind ?? 'trailer';
  if (!previous) return { stale: true, reason: 'never built', prepareStale: true, unpublished: kind === 'trailer', summary: 'never built' };
  const prepareStale = Boolean(item.prepare) && previous.prepareHash !== hashPathspecs(item.prepare.inputs ?? []);
  const inputsStale = previous.inputsHash !== hashPathspecs(item.inputs ?? []);
  const unpublished = kind === 'trailer' && !(previous.file && fs.existsSync(path.join(repoRoot, previous.file)));
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

// The hash covers every tracked file under the pathspecs (its blob id from the
// index) plus the content of anything modified or untracked in the working
// tree, so an unstaged edit counts as a change too. Ignored files do not.
function hashPathspecs(pathspecs) {
  if (pathspecs.length === 0) return 'none';
  const hash = crypto.createHash('sha256');
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
