// Metadata inputs for this repository - unique to Demo-Using-Clarity.
//
// Everything here is curated by hand. Derived facts (stack, metrics, git,
// screenshots) are computed by scripts/generate-project-meta.mjs, which writes
// project.meta.json. Run it with:
//   npm run meta          regenerate project.meta.json
//   npm run meta:check    fail if project.meta.json is stale

import path from 'node:path';

// Screenshots are captured by the portfolio (npm run capture there). Point
// PORTFOLIO_ROOT elsewhere, or drop images in ./project-media, to override.
const portfolioRoot = process.env.PORTFOLIO_ROOT ?? String.raw`C:\Users\Gaming PC\Desktop\Repos\portfolio`;

export default {
  slug: "user-hub-admin",
  classification: "web-app",

  curated: {
    "title": "User Hub Admin",
    "subtitle": "Angular admin dashboard",
    "description": "A legacy Angular admin demo using browser-local state for user management and dashboard flows.",
    "tags": [
      "Angular",
      "Admin UI",
      "LocalStorage"
    ],
    "accent": "#06b6d4",
    "deploymentUrl": "https://user-hub-admin-git.pages.dev/",
    "localUrl": "http://127.0.0.1:4109/",
    "buildCommand": "npm run build",
    "buildOutput": "dist",
    "runCommand": "npm start -- --host 127.0.0.1 --port 4109",
    "devPort": 4109,
    "showcaseTier": "more"
  },

  // How the portfolio screenshot pipeline photographs this project.
  capture: {
    "route": "/"
  },

  scores: {
    "priorityScore": 66,
    "demoabilityScore": 72,
    "depthScore": 64,
    "polishScore": 68,
    "uniquenessScore": 62,
    "maintenanceScore": 62
  },

  analysisNotes:
    "Legacy Angular admin dashboard with local state; good archive support for CRUD/admin UI experience.",

  media: {
    sourceDir: path.join(portfolioRoot, "public", "project-shots", "user-hub-admin", "latest"),
    publicPathPrefix: "/project-shots/user-hub-admin/latest",
    primaryProfile: "card"
  }
};
