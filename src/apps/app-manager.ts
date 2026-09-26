import type { ToolDispatcher } from "../confirmations/gate.js";
import type { Tool, ToolResult } from "../jarvis/tool-types.js";
import type { AppConnector } from "./connector.js";
import type { ConnectedAppsRepo } from "./app-registry.js";
import type { ConnectedApp } from "../types.js";

/** Namespaced tool name so two apps can publish the same tool name safely. */
export function appToolName(appName: string, toolName: string): string {
  return `${appName}.${toolName}`;
}

/**
 * Loads a connected app's tools into the SAME dispatcher/catalogue as Jarvis's
 * own tools, so they work on text and voice alike. The app's descriptions are
 * passed to the model as-is. If an app tool declares confirmable, it inherits
 * Jarvis's enforced confirmation — permissions live in Jarvis, not the app.
 * Every app-tool call is logged as a receipt by the gate, like any other.
 */
export class AppManager {
  private readonly connectors = new Map<string, AppConnector>();
  private readonly toolNamesByApp = new Map<string, string[]>();

  constructor(
    private readonly repo: ConnectedAppsRepo,
    private readonly dispatcher: ToolDispatcher,
    /** Injected so tests can supply an in-process fake connector. */
    private readonly makeConnector: (app: ConnectedApp) => AppConnector,
  ) {}

  /** Register the app and load its tools. Called after Sid confirms connect_app. */
  async connect(input: { name: string; baseUrl: string; authSecret: string }): Promise<{ app: ConnectedApp; toolNames: string[] }> {
    const app = this.repo.add(input);
    const connector = this.makeConnector(app);
    this.connectors.set(app.id, connector);
    const toolNames = await this.loadTools(app, connector);
    return { app, toolNames };
  }

  private async loadTools(app: ConnectedApp, connector: AppConnector): Promise<string[]> {
    const specs = await connector.listTools();
    const names: string[] = [];
    for (const spec of specs) {
      const registeredName = appToolName(app.name, spec.name);
      const tool: Tool = {
        name: registeredName,
        description: spec.description,
        parameters: spec.parameters,
        confirmable: spec.confirmable === true,
        async run(args): Promise<ToolResult> {
          const res = await connector.callTool(spec.name, args);
          return { ok: res.ok, status: res.status, message: res.message, data: res.data };
        },
      };
      this.dispatcher.register(tool);
      names.push(registeredName);
    }
    this.toolNamesByApp.set(app.id, names);
    return names;
  }

  disconnect(appId: string): boolean {
    const names = this.toolNamesByApp.get(appId) ?? [];
    for (const n of names) this.dispatcher.unregister(n);
    this.toolNamesByApp.delete(appId);
    this.connectors.delete(appId);
    return this.repo.remove(appId);
  }

  connectorFor(appId: string): AppConnector | undefined {
    return this.connectors.get(appId);
  }

  list(): ConnectedApp[] {
    return this.repo.list();
  }
}
