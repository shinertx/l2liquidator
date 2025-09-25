import { log } from './logger';

type AlertLevel = 'info' | 'warn' | 'critical';

const slackWebhook = process.env.SLACK_WEBHOOK_URL;
const pagerDutyKey = process.env.PAGERDUTY_API_KEY;

async function postJson(url: string, payload: unknown) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      log.warn({ url, status: res.status, text }, 'alert-post-failed');
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'alert-post-exception');
  }
}

export async function sendSlackAlert(title: string, details: Record<string, unknown>, level: AlertLevel = 'warn') {
  if (!slackWebhook) return;
  const meta = Object.entries(details)
    .map(([k, v]) => `• *${k}*: ${v}`)
    .join('\n');
  const emoji = level === 'critical' ? ':rotating_light:' : level === 'warn' ? ':warning:' : ':information_source:';
  await postJson(slackWebhook, {
    text: `${emoji} ${title}\n${meta}`,
  });
}

export async function sendPagerDutyAlert(title: string, details: Record<string, unknown>) {
  if (!pagerDutyKey) return;
  await postJson('https://events.pagerduty.com/v2/enqueue', {
    routing_key: pagerDutyKey,
    event_action: 'trigger',
    payload: {
      summary: title,
      source: 'l2-liquidator',
      severity: 'warning',
      custom_details: details,
    },
  });
}

export async function emitAlert(title: string, details: Record<string, unknown>, level: AlertLevel = 'warn') {
  log.warn({ title, details, level }, 'alert');
  await Promise.all([
    sendSlackAlert(title, details, level),
    sendPagerDutyAlert(title, details),
  ]);
}
