import * as vscode from "vscode";
import { SidebarViewProvider } from "./providers/SidebarProvider";
import { registerHighlightDiagnosticsCommand } from "./commands/diagnostics";
import { registerReportStruggleCommand } from "./commands/reportStruggle";
import { flattenSkillpaths, getRoadmap } from "./api/client";

export function activate(context: vscode.ExtensionContext) {
  // 1. Initialize the main Sidebar Provider
  const provider = new SidebarViewProvider(context.extensionUri);

  // 2. Register WebViews
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    SidebarViewProvider.viewType,
    provider
  );

  // 3. Register Commands
  const highlightCmd = registerHighlightDiagnosticsCommand();
  const reportStruggleCmd = registerReportStruggleCommand(provider);
  
  // Test explicitly opening the sidebar
  const buildSidebarCmd = vscode.commands.registerCommand(
    "anti-copilot.openSidebar",
    () => {
      vscode.commands.executeCommand("anti-copilot.sidebar.focus");
    }
  );

  // 4. URI Handler (deep linking from frontend)
  const uriHandler = vscode.window.registerUriHandler({
    async handleUri(uri: vscode.Uri) {
      if (uri.path === "/open-task") {
        const queryParams = new URLSearchParams(uri.query);
        const roadmapId = queryParams.get("roadmapId");
        const taskId = queryParams.get("taskId");

        if (roadmapId && taskId) {
          try {
            const data = await getRoadmap(roadmapId);
            const skillpath = flattenSkillpaths(data).find(
              (s) => s.skillpath_id === taskId
            );

            if (skillpath) {
              provider.updateActiveTask(skillpath, roadmapId, data);
              await vscode.commands.executeCommand("anti-copilot.sidebar.focus");
              // Opening from the dashboard is an explicit "let's start coding" signal,
              // so prefill an editor with starter code when available.
              await provider.openActiveCodingProblem();
            } else {
              vscode.window.showErrorMessage(`Task "${taskId}" not found in roadmap "${roadmapId}".`);
            }
          } catch (error: any) {
            vscode.window.showErrorMessage(`Connection Error: ${error.message}`);
          }
        }
      }
    }
  });

  // 5. Refetch the active roadmap whenever the VS Code window regains focus.
  //    Pairs with the frontend's window-focus refetch; keeps the extension in
  //    sync with status / content changes made elsewhere without polling.
  const focusListener = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      void provider.refreshActiveRoadmap();
    }
  });

  // 6. Add all disposables to context
  context.subscriptions.push(
    sidebarRegistration,
    highlightCmd,
    reportStruggleCmd,
    buildSidebarCmd,
    uriHandler,
    focusListener
  );
}

export function deactivate() {}
