#!/usr/bin/env node
// The media contract of this project, as a unit test (node --test, no
// dependencies): what the portfolio will show about it is present, current
// and not junk.
//
//   npm run test:media
//
// It reads what the scripts wrote (project.meta.json, project-media/*.json,
// the published files) and the config they read, and fails when:
//   - the metadata is missing or malformed, or its identity is generic;
//   - a screenshot profile failed, was captured past a skipped recipe step, or
//     photographed a blank/black/loading frame (the recorded frame statistics);
//   - a screenshot file is missing or not the size its profile promises;
//   - a trailer, capture or artwork item is unrecorded, its web copy is
//     missing, over the size cap, or (for videos) outside its duration window;
//   - the link-preview card, the icon set or the rendered media are stale
//     (the scripts' own --check runs).
// Everything else that moves with every commit (line counts, git) is not a
// test concern; refresh it on release.
//
// Installed by the portfolio meta toolkit; edit the template there.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import config from './project-meta.config.mjs';
import { DEFAULT_QUALITY, PROFILES, assessFrame } from './project-media-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const mediaDir = path.join(repoRoot, 'project-media');
const meta = readJson(path.join(repoRoot, 'project.meta.json'));
const capture = readJson(path.join(mediaDir, 'capture.json'));
const trailers = readJson(path.join(mediaDir, 'trailers.json'));
const skipsShots = Boolean(config.capture?.skip);
const curated = config.curated ?? {};

test('project.meta.json exists and matches the config identity', () => {
  assert.ok(meta, 'project.meta.json is missing - run: npm run meta');
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.identity?.slug, config.slug);
  assert.equal(meta.identity?.title, curated.title);
  assert.equal(meta.identity?.description, curated.description);
  assert.deepEqual(meta.identity?.tags, curated.tags);
  assert.equal(meta.links?.deploymentUrl, curated.deploymentUrl);
});

test('the curated identity is specific to this project', () => {
  assert.ok(curated.title && curated.title.length >= 3, 'title');
  assert.ok(curated.subtitle && curated.subtitle.length >= 10, 'subtitle says what it is');
  assert.ok(curated.description && curated.description.length >= 80, 'description is at least a sentence or two');
  assert.ok(!/^(a|an|the) (react|angular|vue|web) (app|application|project)\.?$/i.test(curated.description), 'description is not a placeholder');
  assert.ok(Array.isArray(curated.tags) && curated.tags.length >= 3, 'at least three tags');
  assert.match(String(curated.accent ?? ''), /^#[0-9a-f]{6}$/i, 'accent is a hex colour');
  if (curated.deploymentUrl) assert.match(curated.deploymentUrl, /^https:\/\//, 'deployment URL is https');
});

test('every screenshot profile was captured cleanly', { skip: skipsShots && 'this project renders its pictures' }, () => {
  assert.ok(capture, 'project-media/capture.json is missing - run: npm run shots');
  const byProfile = new Map((capture.profiles ?? []).map((entry) => [entry.profile, entry]));
  for (const name of Object.keys(PROFILES)) {
    const entry = byProfile.get(name);
    assert.ok(entry, name + ' was not captured');
    assert.equal(entry.status, 'captured', name + ': ' + (entry.error ?? entry.status));
    // A step marked optional may be skipped (a pointer grab on a touch layout); a required one may not.
    const required = (entry.skipped ?? []).filter((note) => !note.startsWith('optional step skipped'));
    assert.deepEqual(required, [], name + ': recipe steps were skipped');
    assert.ok(entry.stats, name + ': no frame statistics (recapture with the current scripts)');
    const problems = assessFrame(entry.stats, { ...DEFAULT_QUALITY, ...(config.capture?.quality ?? {}) });
    assert.deepEqual(problems, [], name + ': the frame does not show the app');
  }
});

test('every screenshot file is present at its profile size', { skip: skipsShots && 'this project renders its pictures' }, () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const file = path.join(mediaDir, name + '.jpg');
    assert.ok(fs.existsSync(file), name + '.jpg is missing');
    const size = jpegSize(fs.readFileSync(file));
    assert.ok(size, name + '.jpg is not a JPEG');
    assert.equal(size.width, profile.width, name + ' width');
    if (!profile.fullPage) assert.equal(size.height, profile.height, name + ' height');
    else assert.ok(size.height >= profile.height, name + ' is at least the viewport tall');
  }
});

test('the metadata lists the screenshots it has', () => {
  assert.ok(meta);
  const images = meta.media?.images ?? [];
  const expected = skipsShots ? ['card', 'og'] : Object.keys(PROFILES);
  for (const name of expected) {
    assert.ok(images.some((image) => image.profile === name), 'media.images lacks ' + name);
  }
  assert.ok(meta.media?.primary, 'media.primary is set');
});

const items = config.trailers?.items ?? [];
test('every rendered media item is recorded and published', { skip: items.length === 0 && 'no trailers configured' }, () => {
  assert.ok(trailers, 'project-media/trailers.json is missing - run: npm run trailers');
  const recorded = new Map((trailers.items ?? []).map((item) => [item.id, item]));
  const maxBytes = config.trailers?.maxBytes ?? 20 * 1024 * 1024;
  for (const item of items) {
    const entry = recorded.get(item.id);
    assert.ok(entry, item.id + ' was never built');
    assert.ok(entry.inputsHash && entry.builtAt, item.id + ' has no build record');
    const kind = item.kind ?? 'trailer';
    if (kind === 'stills') {
      for (const output of item.outputs ?? []) assert.ok(fs.existsSync(path.join(repoRoot, output)), item.id + ': ' + output + ' is missing');
      continue;
    }
    assert.ok(entry.file && fs.existsSync(path.join(repoRoot, entry.file)), item.id + ': ' + entry.file + ' is missing');
    assert.ok(entry.bytes > 0 && entry.bytes <= maxBytes, item.id + ': ' + entry.bytes + ' bytes exceeds the cap');
    assert.ok(entry.urlPath, item.id + ' has no URL');
    if (kind === 'trailer' || kind === 'capture') {
      assert.ok(entry.poster && fs.existsSync(path.join(repoRoot, entry.poster)), item.id + ': poster is missing');
      const [minSeconds, maxSeconds] = item.durationRange ?? [kind === 'capture' ? (item.recipe?.durationMs ?? 20000) / 1000 - 2 : 5, 180];
      assert.ok(entry.duration >= minSeconds && entry.duration <= maxSeconds, item.id + ': duration ' + entry.duration + ' s is outside ' + minSeconds + '-' + maxSeconds);
      assert.ok(entry.width >= 640 && entry.height >= 360, item.id + ': ' + entry.width + 'x' + entry.height + ' is too small');
      if (kind === 'capture') assert.deepEqual(assessFrame(entry.stats, item.recipe?.quality), [], item.id + ': the recording does not show the app');
    }
  }
});

test('the metadata carries every published trailer and artwork', { skip: items.length === 0 && 'no trailers configured' }, () => {
  assert.ok(meta);
  const listed = new Set([...(meta.media?.trailers ?? []), ...(meta.media?.artwork ?? [])].map((entry) => entry.id));
  for (const item of items) {
    if ((item.kind ?? 'trailer') === 'stills') continue;
    assert.ok(listed.has(item.id), 'project.meta.json does not list ' + item.id + ' - run: npm run meta');
  }
  for (const entry of [...(meta.media?.trailers ?? []), ...(meta.media?.artwork ?? [])]) {
    assert.match(entry.url, /^https?:\/\//, entry.id + ' has an absolute URL');
  }
});

test('the link-preview card, icons and rendered media are current', () => {
  for (const [label, script] of [['social', 'generate-social-preview.mjs'], ['icons', 'generate-app-icons.mjs'], ['trailers', 'build-project-trailers.mjs']]) {
    if (label === 'trailers' && items.length === 0) continue;
    // A rendered item that needs Blender or a GPU is rebuilt on the PC's CI chain; here only items this machine could render are held to being current.
    const checkArgs = label === 'trailers' ? ['--check', '--buildable-only'] : ['--check'];
    const run = spawnSync(process.execPath, [path.join(scriptDir, script), ...checkArgs], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(run.status, 0, label + ' --check: ' + (run.stderr || run.stdout).trim().split('\n').slice(-2).join(' '));
  }
});

// ------------------------------------------------------------------ helpers

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Width and height from the first SOF marker of a baseline/progressive JPEG.
function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}
