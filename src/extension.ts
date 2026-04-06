import * as vscode from "vscode";
import { SidebarViewProvider } from "./providers/SidebarProvider";
import { registerHighlightDiagnosticsCommand } from "./commands/diagnostics";
import { registerReportStruggleCommand } from "./commands/reportStruggle";

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
          vscode.window.showInformationMessage(`Testing task: ${taskId}`);
          
          try {
            const response = await fetch(`http://localhost:8000/v1/roadmaps/${roadmapId}`);
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`Backend error (${response.status}): ${errorText}`);
            }
            const data = (await response.json()) as any;
            
            // Find the specific task in the roadmap data
            const normTaskId = taskId.trim().toLowerCase();
            const skillpath = (data.skillpaths || []).find((s: any) => {
              const sId = String(s.skillpath_id || "").trim().toLowerCase();
              const sTitle = String(s.title || "").trim().toLowerCase();
              return sId === normTaskId || sTitle === normTaskId;
            });
            
            if (skillpath) {
              provider.updateActiveTask(skillpath, roadmapId, data);
              vscode.commands.executeCommand("anti-copilot.sidebar.focus");
            } else {
              vscode.window.showErrorMessage(`Task "${taskId}" not found in roadmap "${roadmapId}".`);
            }
          } catch (error: any) {
            vscode.window.showErrorMessage(`Connection Error: ${error.message}. Is the backend running on port 8000?`);
          }
        }
      }
    }
  });

  // 5. Add all disposables to context
  context.subscriptions.push(
    sidebarRegistration,
    highlightCmd,
    reportStruggleCmd,
    buildSidebarCmd,
    uriHandler
  );
}

export function deactivate() {}
