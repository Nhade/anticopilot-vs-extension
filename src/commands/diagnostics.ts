import * as vscode from 'vscode';

const diagnosticsHighlightDecoration =
  vscode.window.createTextEditorDecorationType({
    border: "1px solid oklch(0.8118 0.15 73.74)",
    borderRadius: "6px",
    backgroundColor: "oklch(0.8118 0.15 73.74/40%)",
  });

export function registerHighlightDiagnosticsCommand() {
  return vscode.commands.registerCommand(
    "anti-copilot.highlightDiagnostics",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active editor found.");
        return;
      }

      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);

      if (diagnostics.length === 0) {
        vscode.window.showInformationMessage("No diagnostics found!");
        return;
      }

      const regions = diagnostics.map((d) => {
        return new vscode.Range(
          d.range.start.line,
          d.range.start.character,
          d.range.end.line,
          d.range.end.character,
        );
      });
      editor.setDecorations(diagnosticsHighlightDecoration, regions);
    }
  );
}
