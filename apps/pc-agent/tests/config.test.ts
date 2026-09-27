import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("config", () => {
  it("accepts an explicit valid config", () => {
    const cfg = loadConfig({ jarvisUrl: "https://jarvis.example.workers.dev/", pcAgentToken: "tok" });
    expect(cfg.jarvisUrl).toBe("https://jarvis.example.workers.dev"); // trailing slash stripped
    expect(cfg.pcAgentToken).toBe("tok");
    expect(cfg.pollMs).toBe(30_000); // default
    expect(cfg.vaultDir).toBeUndefined();
  });

  it("fails closed without a URL or token — with the fix in the message", () => {
    expect(() => loadConfig({ pcAgentToken: "tok" })).toThrow(ConfigError);
    expect(() => loadConfig({ pcAgentToken: "tok" })).toThrow("JARVIS_URL");
    expect(() => loadConfig({ jarvisUrl: "https://x" })).toThrow("PC_AGENT_TOKEN");
  });

  it("rejects a non-http URL and a silly poll interval", () => {
    expect(() => loadConfig({ jarvisUrl: "ftp://x", pcAgentToken: "t" })).toThrow(ConfigError);
    expect(() => loadConfig({ jarvisUrl: "https://x", pcAgentToken: "t", pollMs: 10 })).toThrow("POLL_MS");
  });
});
