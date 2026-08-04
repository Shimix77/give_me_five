"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const oracleRoot = path.join(root, "deploy", "oracle");
const dockerfile = fs.readFileSync(path.join(oracleRoot, "Dockerfile"), "utf8");
const compose = fs.readFileSync(path.join(oracleRoot, "compose.yml"), "utf8");
const caddy = fs.readFileSync(path.join(oracleRoot, "Caddyfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(oracleRoot, "Dockerfile.dockerignore"), "utf8");
const launcher = fs.readFileSync(path.join(root, "start.command"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const lockfile = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");

test("Oracle runtime is isolated from the local launcher and working directory", () => {
  assert.doesNotMatch(launcher, /deploy\/oracle|GMF_ACCESS_KEY|GMF_WORK_DIR|GMF_MODEL_DIR/);
  assert.match(compose, /context: \.\.\/\.\./);
  assert.match(compose, /dockerfile: deploy\/oracle\/Dockerfile/);
  assert.match(compose, /gmf-models:\/var\/lib\/give-me-five\/models/);
  assert.match(compose, /\/var\/lib\/give-me-five\/session:size=/);
  assert.doesNotMatch(compose, /\.gmf-work/);
  assert.equal(fs.existsSync(path.join(root, "Dockerfile.oracle")), false);
  assert.equal(fs.existsSync(path.join(root, "docker-compose.oracle.yml")), false);
});

test("Oracle image contains every server runtime module", () => {
  for (const file of [
    "give_me_five.html",
    "server.js",
    "transcribe-worker.js",
    "render-timing.js",
    "marker-analysis.js",
    "visual-entry.js",
    "music-suitability.js"
  ]) {
    assert.match(dockerfile, new RegExp(file.replace(".", "\\.")));
  }
  assert.match(dockerfile, /GMF_WORK_DIR=\/var\/lib\/give-me-five\/session/);
  assert.match(dockerfile, /GMF_MODEL_DIR=\/var\/lib\/give-me-five\/models/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerignore, /^\*\*/m);
  assert.match(dockerignore, /!server\.js/);
  assert.match(dockerignore, /!assets\/\*\*/);
  assert.doesNotMatch(dockerignore, /!node_modules|!\.gmf-work|!\.env/);
});

test("Oracle edge only exposes HTTPS and limits incoming bodies", () => {
  assert.match(compose, /- "80:80"/);
  assert.match(compose, /- "443:443"/);
  assert.doesNotMatch(compose, /ports:[\s\S]{0,100}"4173:4173"/);
  assert.match(compose, /backend:\s*\n\s*internal: true/);
  assert.match(caddy, /request_body\s*\{[\s\S]{0,120}max_size 320MB/);
  assert.match(caddy, /reverse_proxy editor:4173/);
});

test("cloud upload guard runs before Multer writes the file", () => {
  assert.match(server, /function reserveMediaUpload\(/);
  assert.match(server, /activeUploads >= MAX_RUNNING_UPLOADS/);
  assert.match(server, /availableUploadBytes\(\) < MAX_UPLOAD_BYTES \+ MIN_FREE_UPLOAD_BYTES/);
  assert.match(server, /app\.post\("\/api\/media", reserveMediaUpload, upload\.single\("file"\)/);
});

test("known high-risk transitive dependencies are overridden in the lockfile", () => {
  assert.match(lockfile, /overrides:\s*\n\s*adm-zip: 0\.6\.0\s*\n\s*sharp: 0\.35\.3/);
  assert.doesNotMatch(lockfile, /adm-zip@0\.5\.18/);
  assert.doesNotMatch(lockfile, /sharp@0\.34\.5/);
});
