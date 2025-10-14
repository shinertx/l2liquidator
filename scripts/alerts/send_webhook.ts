import { config as loadEnv } from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { URL } from 'url';

const root = path.resolve(__dirname, '..', '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const result = loadEnv({ path: envPath });
  dotenvExpand.expand(result as any);
}

const webhook = process.env.ALERT_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;

if (!webhook) {
  console.error('Missing ALERT_WEBHOOK_URL / DISCORD_WEBHOOK_URL / SLACK_WEBHOOK_URL environment variable.');
  process.exit(1);
}

const message = process.argv.slice(2).join(' ').trim();
if (!message) {
  console.error('Usage: ts-node scripts/alerts/send_webhook.ts "message text"');
  process.exit(1);
}

const payload = JSON.stringify({
  content: message,
});

const url = new URL(webhook);

const req = https.request(
  {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
    },
  },
  (res) => {
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`Alert sent (status ${res.statusCode}).`);
    } else {
      console.error(`Failed to send alert. Status: ${res.statusCode}`);
      res.on('data', (chunk) => {
        process.stderr.write(chunk);
      });
      process.exitCode = 1;
    }
  },
);

req.on('error', (err) => {
  console.error('Failed to send alert:', err);
  process.exit(1);
});

req.write(payload);
req.end();
