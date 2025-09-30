import OpenAI from 'openai';
import { AppConfig } from '../infra/config';

let openai: OpenAI | undefined;

function client(cfg: AppConfig): OpenAI | undefined {
  if (openai) return openai;
  const apiKey = cfg.analysis?.openaiKey;
  if (!apiKey) return undefined;
  openai = new OpenAI({ apiKey });
  return openai;
}

export async function diagnoseFailure(cfg: AppConfig, context: any): Promise<string | null> {
  const c = client(cfg);
  if (!c) return null;

  const prompt = `
    As a world-class quant engineer from the YC-founder collective, analyze the following failed liquidation attempt.
    Your prime directive is to identify the most likely root cause to help us capture >=90% of opportunities safely.

    Context:
    ${JSON.stringify(context, null, 2)}

    Instructions:
    1. State the most likely root cause in a single, concise sentence.
    2. Provide a brief, 2-3 sentence explanation of why this is the likely cause, referencing the context provided.
    3. Suggest a concrete next step for investigation (e.g., "Check liquidity on Camelot for this pair," or "Verify oracle price against DEX price at time of failure.").
    4. Be concise, professional, and direct.
  `;

  try {
    const completion = await c.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.1,
      max_tokens: 250,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    return `OpenAI diagnosis failed: ${(err as Error).message}`;
  }
}
