import fs from 'fs';
import path from 'path';
import { log } from '../infra/logger';

type BridgeIntent = {
  id: string;
  chainId: number;
  token: `0x${string}`;
  deficitUsd: number;
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
};

const intentsLogPath = process.env.FABRIC_BRIDGE_INTENT_PATH ?? 'logs/fabric_bridge_intents.jsonl';
const bridgeWebhook = process.env.FABRIC_BRIDGE_WEBHOOK;

export class BridgeBroker {
  private readonly brokerLog = log.child({ module: 'fabric.bridge' });

  publish(intent: Omit<BridgeIntent, 'id' | 'createdAt'>): void {
    const record: BridgeIntent = {
      ...intent,
      id: `${intent.chainId}-${intent.token}-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    this.appendToFile(record);
    if (bridgeWebhook) {
      this.postWebhook(record).catch((err) => {
        this.brokerLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'bridge-webhook-failed');
      });
    }
  }

  private appendToFile(intent: BridgeIntent): void {
    const dir = path.dirname(intentsLogPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(intentsLogPath, `${JSON.stringify(intent)}\n`, 'utf8');
    this.brokerLog.info(intent, 'bridge-intent-recorded');
  }

  private async postWebhook(intent: BridgeIntent): Promise<void> {
    try {
      const res = await fetch(bridgeWebhook!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intent),
      });
      if (!res.ok) {
        this.brokerLog.warn({ status: res.status, statusText: res.statusText }, 'bridge-webhook-nok');
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
