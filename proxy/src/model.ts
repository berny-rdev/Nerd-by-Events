import Anthropic from '@anthropic-ai/sdk';

import type { Env, ModelRequest, ModelResult } from './types.ts';

/**
 * One model per route, chosen by how the cost scales.
 *
 * `/expand` runs once per distinct description and its result is cached ~30
 * days, so it is the cheapest place in the system to buy quality — and the most
 * valuable, since every artist and event entry becomes a literal search query
 * and a name omitted here is never recovered downstream. Measured on the same
 * prompt, Sonnet returned roughly double the reference coverage of Haiku and
 * named real touring producers rather than agency roster members.
 *
 * `/classify` is per event and high volume, where Haiku's judgement is
 * sufficient and the cost difference is not.
 */
export const MODELS = {
  expand: 'claude-sonnet-5',
  classify: 'claude-haiku-4-5-20251001',
} as const;

/**
 * The only place the Worker talks to Anthropic.
 *
 * No `thinking` and no `output_config.effort`: these are short structured
 * extraction calls, not reasoning work, and Haiku 4.5 rejects `effort` outright.
 */
export async function callModel(env: Env, request: ModelRequest): Promise<ModelResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: 'user', content: request.user }],
    // Spread rather than passing undefined: omitting the field entirely is what
    // selects each model's own default.
    ...(request.thinking === 'disabled' ? { thinking: { type: 'disabled' as const } } : {}),
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  return { text, stopReason: message.stop_reason };
}

/**
 * Models sometimes wrap JSON in a markdown fence despite being told not to.
 * Stripping one is cheaper than treating it as a failure.
 */
export function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return fenced ? fenced[1].trim() : text.trim();
}

/** Parses the model's text as JSON, or returns null. Never throws. */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(stripFence(text));
  } catch {
    return null;
  }
}
