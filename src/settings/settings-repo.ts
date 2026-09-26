/**
 * Settings (Phase 4). A global shadow flag plus per-feature flags. Sid turns
 * shadow on/off by just saying so; the model calls settings_update. Shadow
 * state is injected into the system prompt.
 */
export class SettingsRepo {
  private readonly map = new Map<string, string>();

  get(key: string): string | undefined {
    return this.map.get(key);
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  all(): Record<string, string> {
    return Object.fromEntries(this.map);
  }

  /** Global shadow mode. Default OFF, but explicit — not a silent default of behaviour. */
  isShadow(): boolean {
    return this.map.get("shadow") === "on";
  }
  isFeatureShadow(feature: string): boolean {
    return this.isShadow() || this.map.get(`shadow:${feature}`) === "on";
  }
}
