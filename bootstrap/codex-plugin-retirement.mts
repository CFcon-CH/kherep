import type { Settings } from "./render-profile-settings.mts";
import { isRecord } from "./shape.mts";

export const RETIRED_CODEX_PLUGIN = "codex@openai-codex";

export function retiredCodexRegistered(registry: unknown): boolean {
  if (!isRecord(registry) || !isRecord(registry.plugins)) throw new Error("Cannot read installed plugin registry shape.");
  return Object.hasOwn(registry.plugins, RETIRED_CODEX_PLUGIN);
}

// Issue #797. Manifest omission preserves historical enablement. An explicit
// false in each settings scope stops the retired plugin loading after restart.
// Keep the registry, cache and marketplace intact for reversible recovery;
// install_path backs up both previous settings files in the same transaction.
// Hosts without this exact ID in settings or registry gain no tombstone.
export function retireCodexPlugin(settings: Settings, installed = false): Settings {
  const plugins = settings.enabledPlugins;
  if ((!installed && (!plugins || !Object.hasOwn(plugins, RETIRED_CODEX_PLUGIN)))
    || plugins?.[RETIRED_CODEX_PLUGIN] === false) return settings;
  return { ...settings, enabledPlugins: { ...plugins, [RETIRED_CODEX_PLUGIN]: false } };
}
