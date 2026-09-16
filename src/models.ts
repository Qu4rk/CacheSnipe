import type { ModelIdentity, ResolvedOptions } from "./types.js";

/**
 * Model guard.
 *
 * The port must be invisible outside DeepSeek sessions. opencode hands us the
 * model in several shapes depending on the hook (`model.providerID` + `model.api.id`
 * for the system transform, `info.providerID` + `info.modelID` on assistant
 * messages), so extraction is defensive.
 */

export function modelIdentity(model: unknown): ModelIdentity | undefined {
  if (!model || typeof model !== "object") return undefined;
  const record = model as Record<string, unknown>;
  const api = (record["api"] as Record<string, unknown> | undefined) ?? undefined;
  const providerID = firstString(record["providerID"], record["provider"]);
  const modelID = firstString(
    record["modelID"],
    record["id"],
    api?.["id"],
    record["api"] && typeof record["api"] === "string" ? record["api"] : undefined,
  );
  if (!providerID && !modelID) return undefined;
  return { providerID: providerID ?? "", modelID: modelID ?? "" };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function isDeepseekModel(identity: ModelIdentity | undefined, options: ResolvedOptions): boolean {
  if (!options.enabled) return false;
  if (!identity) return false;
  const provider = identity.providerID.toLowerCase();
  const model = identity.modelID.toLowerCase();
  if (options.providers.length > 0 && !options.providers.includes(provider)) return false;
  if (options.models.length > 0 && !options.models.some((entry) => model.includes(entry.toLowerCase()))) {
    return false;
  }
  return (
    provider === "deepseek" ||
    provider.includes("deepseek") ||
    model.includes("deepseek") ||
    options.providers.length > 0
  );
}

export function describeModel(identity: ModelIdentity | undefined): string {
  if (!identity) return "(unknown model)";
  return `${identity.providerID || "?"}/${identity.modelID || "?"}`;
}
