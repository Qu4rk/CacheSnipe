import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelPrice, UsageFields } from "./types.js";

/**
 * Pricing.
 *
 * The upstream pi extension hardcoded a DeepSeek price table. opencode already
 * ships one: `~/.cache/opencode/models.json` carries `cost.{input,output,cache_read}`
 * per model and is refreshed by opencode itself. We read it at startup and only
 * fall back to the values verified on this machine (2026-09) if it is unreadable.
 *
 * Verified 2026-09-16 from models.json:
 *   deepseek-v4-flash  input 0.15  cache_read 0.003     ->  50x
 *   deepseek-v4-pro    input 0.435 cache_read 0.003625  -> 120x
 */

export const DEFAULT_MODELS_JSON = join(homedir(), ".cache", "opencode", "models.json");

export const FALLBACK_DEEPSEEK_PRICES: Record<string, ModelPrice> = {
  "deepseek-v4-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, origin: "fallback" },
  "deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, origin: "fallback" },
  "deepseek-v4-flash-vision-exp": { input: 0.15, output: 0.6, cacheRead: 0.003, origin: "fallback" },
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625, origin: "fallback" },
};

export type PriceTable = {
  readonly origin: "models.json" | "fallback";
  get(providerID: string, modelID: string): ModelPrice | undefined;
  /** All known prices, for diagnostics. */
  entries(): Array<{ id: string; price: ModelPrice }>;
};

type RawCost = { input?: unknown; output?: unknown; cache_read?: unknown };

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toPrice(cost: RawCost, origin: ModelPrice["origin"]): ModelPrice | undefined {
  const input = num(cost.input);
  if (input === undefined) return undefined;
  return {
    input,
    output: num(cost.output) ?? 0,
    cacheRead: num(cost.cache_read) ?? 0,
    origin,
  };
}

export function parsePriceTable(raw: unknown): PriceTable {
  const exact = new Map<string, ModelPrice>();
  const byModel = new Map<string, ModelPrice>();
  if (raw && typeof raw === "object") {
    for (const [providerID, provider] of Object.entries(raw as Record<string, unknown>)) {
      if (!provider || typeof provider !== "object") continue;
      const models = (provider as { models?: unknown }).models;
      if (!models || typeof models !== "object") continue;
      for (const [modelID, model] of Object.entries(models as Record<string, unknown>)) {
        const cost = (model as { cost?: unknown })?.cost;
        if (!cost || typeof cost !== "object") continue;
        const price = toPrice(cost as RawCost, "models.json");
        if (!price) continue;
        exact.set(`${providerID}/${modelID}`, price);
        if (!byModel.has(modelID)) byModel.set(modelID, price);
      }
    }
  }

  return {
    origin: "models.json",
    get(providerID, modelID) {
      return exact.get(`${providerID}/${modelID}`) ?? byModel.get(modelID) ?? FALLBACK_DEEPSEEK_PRICES[modelID];
    },
    entries() {
      return [...exact.entries()].map(([id, price]) => ({ id, price }));
    },
  };
}

export function fallbackPriceTable(): PriceTable {
  return {
    origin: "fallback",
    get(providerID, modelID) {
      if (providerID === "deepseek") return FALLBACK_DEEPSEEK_PRICES[modelID];
      return FALLBACK_DEEPSEEK_PRICES[modelID];
    },
    entries() {
      return Object.entries(FALLBACK_DEEPSEEK_PRICES).map(([id, price]) => ({ id, price }));
    },
  };
}

export function loadPriceTable(path: string = DEFAULT_MODELS_JSON): PriceTable {
  try {
    return parsePriceTable(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return fallbackPriceTable();
  }
}

/** USD saved by serving `tokens` from cache instead of as fresh input. */
export function estimateSavings(price: ModelPrice | undefined, tokens: number): number {
  if (!price) return 0;
  const delta = price.input - price.cacheRead;
  if (delta <= 0) return 0;
  return (tokens / 1_000_000) * delta;
}

/** USD this usage would have cost with no cache reads at all. */
export function estimateUncached(price: ModelPrice | undefined, usage: UsageFields): number {
  if (!price) return 0;
  const inputTokens = usage.input + usage.cacheRead;
  return (inputTokens / 1_000_000) * price.input + (usage.output / 1_000_000) * price.output;
}

export function priceOf(table: PriceTable, providerID: string, modelID: string): ModelPrice | undefined {
  return table.get(providerID, modelID);
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.0000";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.0001) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(4)}`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US");
}
