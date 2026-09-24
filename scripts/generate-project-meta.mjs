#!/usr/bin/env node
// Regenerates this repository's project.meta.json.
//
// Curated facts (title, description, tags, run/build commands, capture recipe,
// portfolio scores) live in ./project-meta.config.mjs, which is unique to this
// repo. Everything else in the metadata is derived from the repo itself:
// package.json, the dependency set, source/test counts, README, git history and
// any captured screenshots.
//
// Usage:
//   node scripts/generate-project-meta.mjs             # write project.meta.json
//   node scripts/generate-project-meta.mjs --check      # fail if it is stale
//   node scripts/generate-project-meta.mjs --json       # print, do not write
//   node scripts/generate-project-meta.mjs --copy-media # pull shots into the repo
//
// This file is installed by the portfolio meta toolkit
// (portfolio/scripts/meta/install-project-meta.mjs). Edit the template there,
// not the copies, or the next install will overwrite your change.

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

import config from './project-meta.config.mjs';

const SCHEMA_VERSION = 1;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const outputPath = path.join(repoRoot, 'project.meta.json');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const jsonOnly = args.has('--json');
const copyMedia = args.has('--copy-media');

const packageJson = readJson(path.join(repoRoot, 'package.json'));
// Repos whose web app lives in a subdirectory (a workspace, or an app folder
// under a thin root) declare it as `appDir`, so the stack is read from there.
const appRoot = config.appDir ? path.join(repoRoot, config.appDir) : repoRoot;
const appPackageJson = appRoot === repoRoot ? null : readJson(path.join(appRoot, 'package.json'));
const dependencies = {
  ...packageJson?.dependencies,
  ...packageJson?.devDependencies,
  ...appPackageJson?.dependencies,
  ...appPackageJson?.devDependencies
};
const npmScripts = packageJson?.scripts ?? {};
const metrics = collectMetrics(repoRoot);
const readme = readReadme(repoRoot);
const media = collectMedia();

const curated = config.curated ?? {};
const meta = pruneEmpty({
  $schema: './scripts/project.meta.schema.json',
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/generate-project-meta.mjs',

  identity: pruneEmpty({
    slug: config.slug,
    // The GitHub repository name, so a worktree or a CI checkout folder does
    // not leak into the metadata; the folder name is the fallback.
    repoName: repoNameFromRemote() || path.basename(repoRoot),
    packageName: packageJson?.name ?? '',
    version: packageJson?.version ?? '',
    title: curated.title ?? titleFromSlug(config.slug),
    subtitle: curated.subtitle ?? '',
    description: curated.description ?? readme.description ?? '',
    tags: curated.tags ?? inferTags(),
    accent: curated.accent ?? '',
    classification: config.classification ?? 'web-app',
    showcaseTier: curated.showcaseTier ?? 'more',
    showcaseOrder: curated.showcaseOrder,
    duplicateOf: curated.duplicateOf,
    excludedReason: curated.excludedReason
  }),

  links: pruneEmpty({
    deploymentUrl: curated.deploymentUrl ?? '',
    localUrl: curated.localUrl ?? '',
    homepage: typeof packageJson?.homepage === 'string' ? packageJson.homepage : '',
    repository: readRepositoryUrl(),
    ...(config.links ?? {})
  }),

  runtime: pruneEmpty({
    packageManager: detectPackageManager(),
    nodeEngine: packageJson?.engines?.node ?? '',
    buildCommand: curated.buildCommand ?? '',
    buildOutput: curated.buildOutput ?? '',
    buildCwd: curated.buildCwd,
    runCommand: curated.runCommand ?? '',
    runCwd: curated.runCwd,
    devPort: curated.devPort,
    fallbackCommand: curated.fallbackCommand,
    fallbackCwd: curated.fallbackCwd,
    fallbackEnv: curated.fallbackEnv,
    serveBasePath: curated.serveBasePath,
    scripts: Object.keys(npmScripts)
  }),

  capture: config.capture ? pruneEmpty({ ...config.capture }) : undefined,

  media: pruneEmpty({
    source: media.source,
    directory: media.directory,
    primary: media.primary,
    images: media.images,
    // Trailers rendered by scripts/build-project-trailers.mjs, addressed by
    // their URL on the deployment, and any hand-listed videos (YouTube, a
    // gameplay capture) from the config.
    trailers: collectTrailers(),
    videos: collectVideos()
  }),

  stack: pruneEmpty({
    framework: detectFramework(),
    language: detectLanguage(),
    runtimeTargets: detectTargets(),
    libraries: detectLibraries(),
    testing: detectTesting(),
    appDirectory: config.appDir ?? undefined,
    dependencyCount: Object.keys(packageJson?.dependencies ?? {}).length,
    devDependencyCount: Object.keys(packageJson?.devDependencies ?? {}).length,
    workspaces: Array.isArray(packageJson?.workspaces)
      ? packageJson.workspaces
      : packageJson?.workspaces?.packages
  }),

  metrics: {
    sourceFiles: metrics.sourceFiles,
    testFiles: metrics.testFiles,
    sourceLines: metrics.sourceLines,
    largestDirectories: metrics.largestDirectories,
    hasReadme: metrics.hasReadme,
    hasTests: metrics.testFiles > 0,
    hasCi: metrics.hasCi,
    hasDocs: metrics.hasDocs
  },

  scores: config.scores ? { ...config.scores } : undefined,
  analysisNotes: config.analysisNotes ?? '',

  git: readGit(),

  readme: pruneEmpty({
    file: readme.file,
    heading: readme.heading
  })
});

if (jsonOnly) {
  process.stdout.write(JSON.stringify(meta, null, 2) + '\n');
  process.exit(0);
}

const previous = readJson(outputPath);
const unchanged = previous ? stableEqual(stripVolatile(previous), stripVolatile(meta)) : false;
if (unchanged && previous.generatedAt) meta.generatedAt = previous.generatedAt;

if (checkOnly) {
  if (!previous) {
    console.error('[project-meta] ' + config.slug + ': project.meta.json is missing. Run: node scripts/generate-project-meta.mjs');
    process.exit(1);
  }
  if (!unchanged) {
    console.error('[project-meta] ' + config.slug + ': project.meta.json is stale. Run: node scripts/generate-project-meta.mjs');
    process.exit(1);
  }
  console.log('[project-meta] ' + config.slug + ': up to date.');
  process.exit(0);
}

if (copyMedia) copyMediaIntoRepo();

fs.writeFileSync(outputPath, JSON.stringify(meta, null, 2) + '\n');
console.log(
  '[project-meta] ' + config.slug + ': ' + (unchanged ? 'unchanged' : 'updated') + ' ' +
  path.relative(repoRoot, outputPath) + ' (' + meta.metrics.sourceFiles + ' source files, ' +
  meta.metrics.testFiles + ' tests, ' + (meta.media?.images?.length ?? 0) + ' images)'
);

// ---------------------------------------------------------------- derivation

function detectPackageManager() {
  if (config.packageManager) return config.packageManager;
  if (typeof packageJson?.packageManager === 'string') return packageJson.packageManager.split('@')[0];
  if (fs.existsSync(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoRoot, 'package-lock.json'))) return 'npm';
  return 'npm';
}

function detectFramework() {
  if (config.framework) return config.framework;
  if (dependencies['@angular/core']) return 'Angular';
  if (dependencies.next) return 'Next.js';
  if (dependencies.svelte) return 'Svelte';
  if (dependencies.vue) return 'Vue';
  if (dependencies['@react-three/fiber']) return 'React Three Fiber';
  if (dependencies.phaser) return 'Phaser';
  if (dependencies.react) return 'React';
  if (dependencies.express) return 'Express';
  if (dependencies.electron) return 'Electron';
  return '';
}

function detectLanguage() {
  if (fs.existsSync(path.join(appRoot, 'tsconfig.json')) || fs.existsSync(path.join(repoRoot, 'tsconfig.json')) || dependencies.typescript) return 'TypeScript';
  return 'JavaScript';
}

function detectTargets() {
  const targets = [];
  if (dependencies.vite || dependencies.react || dependencies['@angular/core'] || dependencies.next) targets.push('web');
  if (dependencies.electron) targets.push('desktop-electron');
  if (dependencies.expo) targets.push('mobile-expo');
  if (dependencies.express || dependencies.fastify) targets.push('node-server');
  return targets;
}

function detectLibraries() {
  const notable = [
    'react', 'react-dom', 'react-router-dom', 'redux', '@reduxjs/toolkit', 'zustand',
    '@angular/core', 'next', 'vue', 'svelte',
    'three', '@react-three/fiber', '@react-three/drei', 'phaser', 'pixi.js',
    'tone', 'howler', 'wavesurfer.js',
    'vite', 'webpack', 'esbuild', 'rollup',
    'electron', 'expo', 'express', 'socket.io',
    'tailwindcss', 'styled-components', 'sass', '@mui/material', 'bootstrap',
    'typescript', 'zod', 'd3'
  ];
  return notable
    .filter((name) => dependencies[name])
    .map((name) => ({ name, version: String(dependencies[name]) }));
}

function detectTesting() {
  const runners = ['vitest', 'jest', '@playwright/test', 'cypress', 'mocha', 'karma', '@testing-library/react'];
  return runners.filter((name) => dependencies[name]);
}

function inferTags() {
  const tags = [];
  const framework = detectFramework();
  if (framework) tags.push(framework);
  if (detectLanguage() === 'TypeScript') tags.push('TypeScript');
  if (dependencies.vite) tags.push('Vite');
  if (dependencies.electron) tags.push('Electron');
  if (dependencies['@playwright/test']) tags.push('Playwright');
  if (dependencies.three) tags.push('Three.js');
  return [...new Set(tags)];
}

function collectMetrics(root) {
  const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.html', '.vue', '.svelte']);
  const ignored = new Set([
    'node_modules', 'dist', 'build', '.git', '.wrangler', 'coverage', '.next', 'out',
    '.cache', '.vite', '.turbo', 'Library', 'obj', 'bin', '.venv', 'venv', '__pycache__',
    'storybook-static', 'playwright-report', 'test-results', 'dist-electron', 'release',
    'vendor', 'project-media', 'artifacts', 'references', 'tmp', 'logs'
  ]);
  let sourceFiles = 0;
  let testFiles = 0;
  let sourceLines = 0;
  let hasReadme = false;
  const perDirectory = new Map();

  walk(root, 0);

  const largestDirectories = [...perDirectory.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([directory, files]) => ({ directory, files }));

  return {
    sourceFiles,
    testFiles,
    sourceLines,
    hasReadme,
    largestDirectories,
    hasCi: fs.existsSync(path.join(root, '.github', 'workflows')),
    hasDocs: fs.existsSync(path.join(root, 'docs'))
  };

  function walk(dir, depth) {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (/^readme\./i.test(entry.name)) hasReadme = true;
      const ext = path.extname(entry.name).toLowerCase();
      if (!sourceExtensions.has(ext)) continue;
      sourceFiles += 1;
      sourceLines += countLines(fullPath);

      const topLevel = path.relative(root, dir).split(path.sep)[0] || '.';
      perDirectory.set(topLevel, (perDirectory.get(topLevel) ?? 0) + 1);

      const isTest = /(^|[.\-_])(test|spec|e2e)([.\-_]|$)/i.test(entry.name) ||
        fullPath.includes(path.sep + 'tests' + path.sep) ||
        fullPath.includes(path.sep + '__tests__' + path.sep);
      if (isTest) testFiles += 1;
    }
  }
}

function countLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return 0;
    const contents = fs.readFileSync(filePath, 'utf8');
    if (!contents) return 0;
    return contents.split('\n').length;
  } catch {
    return 0;
  }
}

function readReadme(root) {
  const candidate = ['README.md', 'readme.md', 'README.MD', 'Readme.md']
    .map((name) => path.join(root, name))
    .find((filePath) => fs.existsSync(filePath));
  if (!candidate) return { file: '', heading: '', description: '' };

  let contents;
  try {
    contents = fs.readFileSync(candidate, 'utf8');
  } catch {
    return { file: '', heading: '', description: '' };
  }

  const lines = contents.split(/\r?\n/);
  const headingLine = lines.find((line) => /^#\s+/.test(line)) ?? '';
  const heading = headingLine.replace(/^#\s+/, '').trim();
  const paragraph = lines
    .filter((line) => !/^[#>![|-]/.test(line.trim()))
    .find((line) => line.trim().length > 40);

  return { file: path.basename(candidate), heading, description: paragraph ? paragraph.trim() : '' };
}

function repoNameFromRemote() {
  const url = readRepositoryUrl();
  if (!url) return '';
  const match = /([^/:]+?)(?:[.]git)?[/]?$/.exec(url.trim());
  return match ? match[1] : '';
}

function readRepositoryUrl() {
  const fromPackage = typeof packageJson?.repository === 'string'
    ? packageJson.repository
    : packageJson?.repository?.url ?? '';
  if (fromPackage) return fromPackage.replace(/^git\+/, '').replace(/\.git$/, '');
  return git(['config', '--get', 'remote.origin.url']).replace(/^git\+/, '').replace(/\.git$/, '');
}

function readGit() {
  const head = git(['rev-parse', '--short', 'HEAD']);
  if (!head) return undefined;
  return pruneEmpty({
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    head,
    lastCommitDate: git(['log', '-1', '--format=%cI']),
    lastCommitSubject: git(['log', '-1', '--format=%s']),
    commitCount: Number(git(['rev-list', '--count', 'HEAD'])) || undefined,
    remote: git(['config', '--get', 'remote.origin.url'])
  });
}

function git(gitArgs) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------- media

function mediaSourceDir() {
  // The repo's own shots win: they were taken by this project's capture recipe
  // and they travel with the repository. The portfolio capture directory is the
  // fallback for projects that have not photographed themselves yet.
  const local = path.join(repoRoot, 'project-media');
  if (fs.existsSync(local)) return { directory: local, source: 'repo-local' };
  const configured = config.media?.sourceDir;
  if (configured && fs.existsSync(configured)) return { directory: configured, source: 'portfolio-capture' };
  if (configured) return { directory: configured, source: 'portfolio-capture-missing' };
  return { directory: '', source: 'none' };
}

function collectMedia() {
  const found = mediaSourceDir();
  const directory = found.directory;
  if (!directory || !fs.existsSync(directory)) {
    return { source: found.source, directory: directory ? toPosix(directory) : '', images: [], primary: '' };
  }

  // publicPathPrefix describes where the portfolio site serves these shots from.
  // A repo's own copies are addressed by their path inside the repo instead.
  const prefix = found.source === 'repo-local' ? undefined : config.media?.publicPathPrefix;
  const images = describeImages(directory, prefix);

  // A capture directory sits under <shots>/<slug>/latest; any loose image in the
  // parent (a hand-picked hero shot, for instance) belongs to this project too.
  if (found.source === 'portfolio-capture') {
    const parentPrefix = prefix ? prefix.replace(/\/$/, '').split('/').slice(0, -1).join('/') : undefined;
    for (const image of describeImages(path.dirname(directory), parentPrefix)) {
      if (!images.some((existing) => existing.path === image.path)) images.push(image);
    }
  }
  images.sort((left, right) => left.profile.localeCompare(right.profile));

  const primaryProfile = config.media?.primaryProfile ?? 'card';
  const primary = images.find((image) => image.profile === primaryProfile) ?? images[0];
  return {
    source: found.source,
    directory: toPosix(directory),
    images,
    primary: primary?.path ?? ''
  };
}

function describeImages(directory, prefix) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(jpe?g|png|webp|gif|svg)$/i.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.statSync(fullPath);
      const size = readImageSize(fullPath);
      return pruneEmpty({
        profile: path.basename(entry.name, path.extname(entry.name)),
        file: entry.name,
        path: prefix
          ? prefix.replace(/\/$/, '') + '/' + entry.name
          : toPosix(path.relative(repoRoot, fullPath)),
        bytes: stat.size,
        width: size?.width,
        height: size?.height,
        capturedAt: stat.mtime.toISOString()
      });
    });
}

// project-media/trailers.json is the record build-project-trailers.mjs keeps of
// what it published; the deployment origin turns its site paths into URLs the
// portfolio can play from anywhere.
function collectTrailers() {
  const record = readJson(path.join(repoRoot, 'project-media', 'trailers.json'));
  if (!record || !Array.isArray(record.items)) return [];
  const origin = deploymentOrigin();
  return record.items
    .filter((item) => (item.kind ?? 'trailer') === 'trailer' && item.urlPath)
    .map((item) => pruneEmpty({
      id: item.id,
      title: item.title,
      url: origin ? origin + item.urlPath : item.urlPath,
      poster: item.posterUrlPath ? (origin ? origin + item.posterUrlPath : item.posterUrlPath) : undefined,
      file: item.file,
      bytes: item.bytes,
      width: item.width,
      height: item.height,
      duration: item.duration,
      orientation: item.orientation,
      builtAt: item.builtAt
    }));
}

function collectVideos() {
  const videos = Array.isArray(config.videos) ? config.videos : [];
  return videos
    .filter((video) => video && video.url)
    .map((video) => pruneEmpty({
      title: video.title,
      url: video.url,
      kind: video.kind ?? videoKind(video.url),
      poster: video.poster,
      description: video.description
    }));
}

function videoKind(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) return 'video';
  return 'link';
}

function deploymentOrigin() {
  const url = config.curated?.deploymentUrl;
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function copyMediaIntoRepo() {
  const found = mediaSourceDir();
  if (!found.directory || found.source === 'repo-local' || !fs.existsSync(found.directory)) return;
  const target = path.join(repoRoot, 'project-media');
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(found.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(jpe?g|png|webp|gif|svg)$/i.test(entry.name)) continue;
    fs.copyFileSync(path.join(found.directory, entry.name), path.join(target, entry.name));
  }
  console.log('[project-meta] ' + config.slug + ': copied screenshots into project-media/');
}

function readImageSize(filePath) {
  let buffer;
  try {
    const handle = fs.openSync(filePath, 'r');
    buffer = Buffer.alloc(65536);
    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
    fs.closeSync(handle);
    buffer = buffer.subarray(0, bytes);
  } catch {
    return undefined;
  }

  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ helpers

function titleFromSlug(slug) {
  return String(slug)
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pruneEmpty(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry === 'string' && entry === '') continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    result[key] = entry;
  }
  return result;
}

function stripVolatile(value) {
  const clone = JSON.parse(JSON.stringify(value));
  // Volatile by nature: these move with time and with commits (including the
  // commit that records this very file), so they never make metadata 'stale'.
  delete clone.generatedAt;
  delete clone.git;
  if (clone.media?.images) {
    clone.media.images = clone.media.images.map((image) => {
      const copy = { ...image };
      delete copy.capturedAt;
      return copy;
    });
  }
  if (clone.media?.trailers) {
    clone.media.trailers = clone.media.trailers.map((trailer) => {
      const copy = { ...trailer };
      delete copy.builtAt;
      return copy;
    });
  }
  return clone;
}

function stableEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
