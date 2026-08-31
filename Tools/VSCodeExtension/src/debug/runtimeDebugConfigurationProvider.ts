import * as vscode from "vscode";

export const RUNTIME_DEBUG_TYPE = "visualbridge-runtime";

/**
 * VisualBridge Runtime 只检查调试类型的配置提供者。
 * 仅支持 attach；instanceId 由调用方（E2E/测试命令）显式传入，不弹选择 UI。
 */
export class RuntimeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  public resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (debugConfiguration.request !== "attach") {
      void vscode.window.showErrorMessage("VisualBridge runtime inspection only supports attach.");
      return undefined;
    }

    if (typeof debugConfiguration.instanceId !== "string" || debugConfiguration.instanceId.length === 0) {
      void vscode.window.showErrorMessage("VisualBridge runtime attach requires a runtime instanceId.");
      return undefined;
    }

    return debugConfiguration;
  }

  public provideDebugConfigurations(
    _folder: vscode.WorkspaceFolder | undefined,
    _token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [{
      name: "VisualBridge Runtime: Attach",
      type: RUNTIME_DEBUG_TYPE,
      request: "attach",
      instanceId: "",
    }];
  }
}
