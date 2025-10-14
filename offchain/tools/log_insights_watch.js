#!/usr/bin/env node
/*
  Watch-mode for log insights. Prints a compact summary every INTERVAL seconds.
  Env:
    LOG_PATH=/tmp/liquidator-dryrun.log (default)
    INTERVAL=30 (seconds)
*/

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOG_PATH = process.env.LOG_PATH || '/tmp/liquidator-dryrun.log';
const INTERVAL = +(process.env.INTERVAL || 30);

function runOnce(cb) {
  const node = process.execPath;
  const script = path.resolve(__dirname, './log_insights.js');
  const p = spawn(node, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d.toString()));
  p.on('close', (code) => {
    if (code !== 0) {
      console.error('[insights-watch] run failed with code', code);
      return cb && cb();
    }
    try {
      const json = JSON.parse(out);
      const lines = [];
      lines.push('[insights]', new Date().toISOString());
      const totalDry = (json.byMsg && json.byMsg['DRY-RUN']) || 0;
      lines.push(`DRY-RUN total: ${totalDry}`);
      for (const cs of json.chainSummaries || []) {
        lines.push(
          `chain ${cs.chain}: dry=${cs.count}, netBps p50=${cs.netBps?.p50 ?? '-'} p90=${cs.netBps?.p90 ?? '-'} max=${cs.netBps?.max ?? '-'}`
        );
      }
      if ((json.insights || []).length) {
        lines.push('tips:');
        for (const t of json.insights) lines.push(`- ${t}`);
      }
      console.log(lines.join(' '));
    } catch (e) {
      console.error('[insights-watch] parse error', e.message);
    }
    cb && cb();
  });
}

function watchLoop() {
  if (!fs.existsSync(LOG_PATH)) {
    console.error('[insights-watch] log not found', LOG_PATH);
    process.exit(2);
  }
  const tick = () => runOnce(() => setTimeout(tick, INTERVAL * 1000));
  tick();
}

if (require.main === module) watchLoop();
