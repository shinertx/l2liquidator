'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

const assets = [
  {
    source: path.join(projectRoot, 'offchain', 'infra', 'rolling-log-target.js'),
    target: path.join(projectRoot, 'dist', 'offchain', 'infra', 'rolling-log-target.js'),
  },
];

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function copyAsset({ source, target }) {
  if (!fs.existsSync(source)) {
    console.error(`[postbuild] missing asset: ${source}`);
    process.exitCode = 1;
    return;
  }

  ensureDirectory(target);
  fs.copyFileSync(source, target);
  console.info(`[postbuild] copied ${path.relative(projectRoot, source)} → ${path.relative(projectRoot, target)}`);
}

for (const asset of assets) {
  copyAsset(asset);
}
