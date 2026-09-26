import 'fake-indexeddb/auto';

// Minimal chrome stub so modules that touch chrome.* can be imported in tests.
// Nothing in the tested code paths actually calls these.
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      _data: {} as Record<string, unknown>,
      async get(key: string) {
        return { [key]: (this._data as Record<string, unknown>)[key] };
      },
      async set(obj: Record<string, unknown>) {
        Object.assign(this._data, obj);
      },
      async remove(key: string) {
        delete (this._data as Record<string, unknown>)[key];
      },
    },
  },
  runtime: {
    getURL: (p: string) => `chrome-extension://test/${p}`,
    sendMessage: async () => undefined,
    lastError: undefined,
  },
  alarms: { getAll: async () => [], create: async () => undefined, clear: async () => true },
  notifications: { create: async () => 'id' },
  action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
};
