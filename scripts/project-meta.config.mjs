// Metadata inputs for this repository - unique to Demo-Using-Clarity.
//
// Everything here is curated by hand: identity, commands, the screenshot recipe
// (capture), the recorded trailer (trailers.items, kind: capture) and where the
// card, icons and trailers are published. scripts/generate-project-meta.mjs
// derives the rest into project.meta.json; scripts/project-media.test.mjs
// checks that everything here was actually produced.
//   npm run meta:refresh   trailers -> shots -> social -> icons -> meta
//   npm run test:media     the media contract

import path from 'node:path';

const portfolioRoot = process.env.PORTFOLIO_ROOT ?? String.raw`C:\Users\Gaming PC\Desktop\Repos\portfolio`;

export default {
  "slug": "user-hub-admin",
  "classification": "web-app",
  "curated": {
    "title": "User Hub Admin",
    "subtitle": "A Clarity-styled admin panel for managing users",
    "description": "An Angular admin panel built with VMware Clarity: create, view, edit and delete users from a dashboard with reusable form components and avatar fallbacks, with every record kept in the browser so the demo needs no server.",
    "tags": [
      "Angular",
      "Clarity UI",
      "Admin",
      "Archive"
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
  "capture": {
    "route": "/",
    "actions": [
      {
        "type": "click",
        "target": {
          "role": "button",
          "name": "Manage users"
        },
        "label": "open the user manager"
      },
      {
        "type": "wait",
        "ms": 1500
      }
    ],
    "waitAfterReadyMs": 800
  },
  "scores": {
    "priorityScore": 66,
    "demoabilityScore": 72,
    "depthScore": 64,
    "polishScore": 68,
    "uniquenessScore": 62,
    "maintenanceScore": 62
  },
  "analysisNotes": "Legacy Angular admin dashboard with local state; good archive support for CRUD/admin UI experience.",
  "social": {
    "htmlFile": "src/index.html",
    "pageTitle": "User Hub Admin",
    "staticDir": "src/assets",
    "imageName": "og-image.jpg",
    "imageUrlPath": "/assets/og-image.jpg"
  },
  "icons": {
    "background": "#083344",
    "themeColor": "#083344",
    "shortName": "User Hub"
  },
  "media": {
    "sourceDir": path.join(portfolioRoot, "public", "project-shots", "user-hub-admin", "latest"),
    "publicPathPrefix": "/project-shots/user-hub-admin/latest",
    "primaryProfile": "card"
  },
  "trailers": {
    "items": [
      {
        "id": "tour",
        "title": "User Hub Admin: create, review, manage",
        "kind": "capture",
        "inputs": [
          "src",
          "angular.json"
        ],
        "source": "deployment",
        "music": "project-media/music/tour.m4a",
        "posterAt": 0.5,
        "recipe": {
          "route": "/",
          "viewport": {
            "width": 1280,
            "height": 720
          },
          "durationMs": 20000,
          "setup": {
            "actions": [
              {
                "type": "waitFor",
                "target": {
                  "role": "button",
                  "name": "Manage users"
                },
                "state": "visible",
                "label": "wait for the timeline"
              }
            ],
            "waitAfterReadyMs": 1200
          },
          "timeline": [
            {
              "type": "click",
              "target": {
                "role": "button",
                "name": "Manage users"
              },
              "label": "manage users",
              "optional": true
            },
            {
              "type": "wait",
              "ms": 3500
            },
            {
              "type": "scroll",
              "deltaY": 300,
              "steps": 2
            },
            {
              "type": "click",
              "target": {
                "role": "button",
                "name": "2. User Directory"
              },
              "label": "directory",
              "optional": true
            },
            {
              "type": "wait",
              "ms": 3500
            },
            {
              "type": "scroll",
              "deltaY": 300,
              "steps": 2
            },
            {
              "type": "click",
              "target": {
                "role": "button",
                "name": "3. Manage Users"
              },
              "label": "manage",
              "optional": true
            },
            {
              "type": "wait",
              "ms": 3000
            },
            {
              "type": "click",
              "target": {
                "role": "button",
                "name": "1. Demo Timeline"
              },
              "label": "timeline",
              "optional": true
            }
          ]
        }
      }
    ]
  }
};
