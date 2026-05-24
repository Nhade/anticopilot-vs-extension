import * as vscode from 'vscode';
import { SidebarViewProvider } from '../providers/SidebarProvider';
import { reportStruggle } from '../api/client';

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

    // Require a real active skillpath — otherwise we'd create low-quality
    // review cards pointing at "unknown-task".
    const activeTask = provider.getActiveTask();
    if (!activeTask?.roadmap_id || !activeTask?.milestone_id || !activeTask?.skillpath_id) {
      vscode.window.showErrorMessage(
        "Open a task from the AntiCopilot dashboard before reporting a struggle — we need to know which skillpath you're working on."
      );
      return;
    }

    const payload = {
      roadmap_id: activeTask.roadmap_id,
      milestone_id: activeTask.milestone_id,
      skillpath_id: activeTask.skillpath_id,
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
          const responseData = await reportStruggle(payload);

          // Display the hint using the sidebar provider
          provider.showHintNotif(responseData.hint, responseData.concept_name);

        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to get help: ${error.message}`);
        }
      }
    );
  });
}
