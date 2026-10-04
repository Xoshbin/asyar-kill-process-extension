import { ExtensionContext as WorkerExtensionContext, extensionBridge } from 'asyar-sdk/worker';
import type { Extension, ExtensionContext, ExtensionResult } from 'asyar-sdk/contracts';
import manifest from '../manifest.json';

const extensionId = resolveExtensionId();
const ctx = new WorkerExtensionContext();
ctx.setExtensionId(extensionId);

class KillProcessExt implements Extension {
  async initialize(_c: ExtensionContext): Promise<void> {}
  async activate(): Promise<void> {}
  async deactivate(): Promise<void> {}
  async executeCommand(_id: string, _args?: Record<string, unknown>): Promise<unknown> {
    return undefined;
  }
  async search(_query: string): Promise<ExtensionResult[]> {
    return [];
  }
}

extensionBridge.registerManifest(
  manifest as unknown as Parameters<typeof extensionBridge.registerManifest>[0],
);
extensionBridge.registerExtensionImplementation(extensionId, new KillProcessExt());

function resolveExtensionId(): string {
  return manifest.id;
}
