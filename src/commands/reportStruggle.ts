import * as vscode from 'vscode';
import { SidebarViewProvider } from '../providers/SidebarProvider';

export function registerReportStruggleCommand(provider: SidebarViewProvider) {
  return vscode.commands.registerCommand("anti-copilot.reportStruggle", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found to analyze.");
      return;
    }

    const document = editor.document;
    const documentUri = document.uri;
    const currentLine = editor.selection.active.line;

    // Grab +/- 10 lines of context around the cursor
    const startLine = Math.max(0, currentLine - 10);
    const endLine = Math.min(document.lineCount - 1, currentLine + 10);
    
    // Convert to a proper text range
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );
    
    const contextCode = document.getText(range);
    
    // Find diagnostics that overlap with our context block
    const allDiagnostics = vscode.languages.getDiagnostics(documentUri);
    const relevantDiagnostics = allDiagnostics.filter(d => 
      !d.range.intersection(range)?.isEmpty
    );

    // Build the diagnostic message string
    const diagnosticMessage = relevantDiagnostics.length > 0
      ? relevantDiagnostics.map(d => `[Line ${d.range.start.line + 1}] ${d.message}`).join("\n")
      : "No syntax errors. User might be stuck on logic.";

    // Retrieve active task information from the provider
    const activeTask = provider.getActiveTask();
    const roadmapId = activeTask?.roadmap_id || "unknown-roadmap";
    const milestoneId = activeTask?.milestone_id || "unknown-milestone";
    const skillpathId = activeTask?.skillpath_id || "unknown-task";

    // Build the payload
    const payload = {
      roadmap_id: roadmapId,
      milestone_id: milestoneId,
      skillpath_id: skillpathId,
      code_context: contextCode,
      language: document.languageId,
      diagnostic_message: diagnosticMessage
    };

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Sending Struggle Signal to AntiCopilot...",
        cancellable: false
      },
      async (progress) => {
        try {
          // Send to the backend
          const response = await fetch("http://localhost:8000/v1/signals/struggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}`);
          }

          const responseData = await response.json() as { hint: string };
          
          // Display the hint using the sidebar provider
          provider.showHintNotif(responseData.hint);

        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to get help: ${error.message}`);
        }
      }
    );
  });
}
