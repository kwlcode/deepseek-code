/**
 * Token accounting and cost estimation.
 *
 * Rates are USD per 1M tokens from the DeepSeek pricing page. Off-peak is half
 * of peak; peak runs Monday-Friday 01:00-04:00 and 06:00-10:00 UTC.
 */

export const RATES = {
  'deepseek-flash': {
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  },
};

const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
};

export function rateTableFor(model) {
  const name = ALIASES[model] ?? model;
  const rates = RATES[name];
  return rates ? { model: name, rates, known: true } : { model, rates: RATES['deepseek-flash'], known: false };
}

/** True during DeepSeek's peak billing window (UTC). */
export function isPeak(date = new Date()) {
  const day = date.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function normalizeUsage(usage) {
  if (!usage) return { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, total: 0, reasoning: 0 };
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(0, input - cacheHit);
  const reasoning =
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.reasoning_tokens ??
    0;
  return { input, output, cacheHit, cacheMiss, total: usage.total_tokens ?? input + output, reasoning };
}

export function estimateCost(model, usage, date = new Date()) {
  const { model: rateModel, rates, known } = rateTableFor(model);
  const tier = isPeak(date) ? 'peak' : 'offPeak';
  const table = rates[tier];
  const tokens = normalizeUsage(usage);
  const usd =
    (tokens.cacheHit / 1_000_000) * table.cacheHit +
    (tokens.cacheMiss / 1_000_000) * table.cacheMiss +
    (tokens.output / 1_000_000) * table.output;
  return { usd, tier, model: rateModel, known, tokens };
}

export function formatCost(usd) {
  if (usd <= 0) return '$0.0000';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count ?? 0);
}

/** Running totals for a session. */
export class UsageTracker {
  constructor(model) {
    this.model = model;
    this.turns = 0;
    this.totals = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, total: 0, reasoning: 0 };
    this.usd = 0;
    this.perModel = new Map();
  }

  add(usage, model = this.model) {
    const entry = estimateCost(model, usage);
    this.turns += 1;
    this.usd += entry.usd;
    for (const key of Object.keys(this.totals)) this.totals[key] += entry.tokens[key] ?? 0;
    const previous = this.perModel.get(entry.model) ?? { usd: 0, tokens: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, total: 0, reasoning: 0 } };
    previous.usd += entry.usd;
    for (const key of Object.keys(previous.tokens)) previous.tokens[key] += entry.tokens[key] ?? 0;
    this.perModel.set(entry.model, previous);
    return entry;
  }

  lastTurnLabel() {
    const { input, output, cacheHit } = this.totals;
    const hitRate = input > 0 ? Math.round((cacheHit / input) * 100) : 0;
    return `${formatTokens(input)} in (${hitRate}% cached) / ${formatTokens(output)} out`;
  }

  summary() {
    const lines = [
      `turns:  ${this.turns}`,
      `model:  ${this.model} (last: ${this.perModel.size ? [...this.perModel.keys()].join(', ') : 'n/a'})`,
      `input:  ${formatTokens(this.totals.input)} tokens (${formatTokens(this.totals.cacheHit)} cache hit / ${formatTokens(this.totals.cacheMiss)} cache miss)`,
      `output: ${formatTokens(this.totals.output)} tokens (${formatTokens(this.totals.reasoning)} reasoning)`,
      `cost:   ${formatCost(this.usd)} (${isPeak() ? 'peak' : 'off-peak'} rates, estimate)`,
    ];
    return lines.join('\n');
  }
}
