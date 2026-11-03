// Issue #757. The usage-band mod's $.state contract. UsageState mirrors
// hooks/lib/usage-window.mts (a contract file imports nothing).
export type UsageState = {
  v: 1;
  window_key: string;
  resets_at: number;
  used_percentage: number;
  elapsed_percentage: number;
  observed_at: string;
  conditions: { threshold: boolean; pace: boolean };
  notified: Partial<Record<"threshold" | "pace", string>>;
};

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { state: UsageState | null; readAt: number };
  }
}
