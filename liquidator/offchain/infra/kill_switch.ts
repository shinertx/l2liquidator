import fs from 'fs';

const DEFAULT_INTERVAL_MS = 1_000;
const pathRaw = process.env.KILL_SWITCH_FILE?.trim();
const pollIntervalMs = Number(process.env.KILL_SWITCH_POLL_MS ?? DEFAULT_INTERVAL_MS);

let lastState = false;
let lastChecked = 0;

function refreshState(force = false): boolean {
  if (!pathRaw) {
    lastState = false;
    return lastState;
  }
  const now = Date.now();
  if (!force && now - lastChecked < pollIntervalMs) {
    return lastState;
  }
  lastChecked = now;
  try {
    lastState = fs.existsSync(pathRaw);
  } catch {
    lastState = false;
  }
  return lastState;
}

export function isKillSwitchActive(options?: { force?: boolean }): boolean {
  return refreshState(options?.force ?? false);
}

export function killSwitchPath(): string | null {
  return pathRaw && pathRaw.length > 0 ? pathRaw : null;
}
