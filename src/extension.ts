import * as vscode from "vscode";
import { SidebarViewProvider } from "./providers/SidebarProvider";
import { registerHighlightDiagnosticsCommand } from "./commands/diagnostics";
import { registerReportStruggleCommand } from "./commands/reportStruggle";
import { captureStruggle } from "./commands/captureStruggle";
import { flattenSkillpaths, getRoadmap } from "./api/client";
import { EventRecorder } from "./telemetry/EventRecorder";
import { SidecarSessionManager } from "./sidecar/SidecarSessionManager";

export function activate(context: vscode.ExtensionContext) {
  // 1. Initialize the main Sidebar Provider
  const provider = new SidebarViewProvider(context.extensionUri);

  // Shadow-mode passive event recorder. Runs alongside explicit
  // reportStruggle so we can later compare its buffer against confirmed
  // struggle events and learn which passive signals actually matter
  // for this learner — instead of guessing thresholds up front.
  const eventRecorder = new EventRecorder();

  // Struggle sidecar: an additive telemetry/session service that runs ALONGSIDE
  // the existing reportStruggle → main-backend flow. It opens a session for the
  // active task, streams passive shadow events, answers remote capture requests,
  // and asks for completeness estimates. Everything fails soft when the sidecar
  // is down — the core extension is never blocked by it.
  const sidecar = new SidecarSessionManager(provider, eventRecorder, () =>
    captureStruggle(provider, eventRecorder),
  );

  // Start (or switch) a sidecar session whenever the learner picks a task.
  const sidecarTaskListener = provider.onDidChangeActiveTask((task) => {
    void sidecar.startSessionForTask(task);
  });

  // 2. Register WebViews
  // retainContextWhenHidden keeps the sidebar's iframe + in-memory state alive
  // when the user switches the primary side bar to Explorer (or another view)
  // and back. Without it VS Code tears the webview down and rebuilds it from
  // scratch on every return — losing fetched reviews/roadmap data and forcing
  // network re-fetches, which is the lag that pushed the user to alt-tab to the
  // browser instead (polluting the window_state focus-out signal).
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    SidebarViewProvider.viewType,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  // 3. Register Commands
  const highlightCmd = registerHighlightDiagnosticsCommand();
  const reportStruggleCmd = registerReportStruggleCommand(provider, eventRecorder, sidecar);

  // Test explicitly opening the sidebar
  const buildSidebarCmd = vscode.commands.registerCommand(
    "anti-copilot.openSidebar",
    () => {
      vscode.commands.executeCommand("anti-copilot.sidebar.focus");
    }
  );

  // Debug aid: dump the current shadow buffer into an untitled JSON doc.
  // Lets us inspect what the recorder captured without firing a struggle.
  const dumpEventBufferCmd = vscode.commands.registerCommand(
    "anti-copilot.dumpEventBuffer",
    async () => {
      const events = eventRecorder.snapshot();
      const doc = await vscode.workspace.openTextDocument({
        language: "json",
        content: JSON.stringify({ size: events.length, events }, null, 2),
      });
      await vscode.window.showTextDocument(doc, { preview: false });
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
    dumpEventBufferCmd,
    uriHandler,
    focusListener,
    eventRecorder,
    sidecarTaskListener,
    sidecar
  );
}

export function deactivate() {}
