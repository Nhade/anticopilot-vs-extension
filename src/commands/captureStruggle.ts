import * as vscode from 'vscode';
import { SidebarViewProvider } from '../providers/SidebarProvider';
import { reportStruggle } from '../api/client';
import { EventRecorder } from '../telemetry/EventRecorder';

/**
 * Structured result of a struggle capture, decoupled from any UI.
 *
 * Callers (the manual "I'm Stuck" command, the sidecar capture_struggle
 * handler) decide how to surface the outcome — a hint popup, a WS reply, etc.
 */
export type CaptureOutcome =
  | { ok: true; concept_id?: string; concept_name?: string; misconception?: string; hint?: string }
  | { ok: false; reason: string };

/**
 * Core of the struggle-reporting flow, extracted so it can be driven both by
 * the user (the reportStruggle command) and remotely (the sidecar asking the
 * extension to capture the current context). It gathers +/- 10 lines around the
 * cursor plus overlapping diagnostics, validates the active skillpath, calls the
 * main backend, and RETURNS the result instead of showing UI.
 *
 * Still emits the same shadow-buffer anchors (struggle_reported / hint_shown)
 * the original command did, so the event timeline is unchanged.
 */
export async function captureStruggle(
  provider: SidebarViewProvider,
  eventRecorder?: EventRecorder,
): Promise<CaptureOutcome> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { ok: false, reason: "No active editor found to analyze." };
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
    return {
      ok: false,
      reason: "Open a task from the AntiCopilot dashboard before reporting a struggle — we need to know which skillpath you're working on.",
    };
  }

  // Anchor the struggle in the event timeline *before* snapshotting, so the
  // window ends on the moment of intervention. Carries only coarse metadata.
  eventRecorder?.mark("struggle_reported", {
    had_diagnostic: relevantDiagnostics.length > 0,
    language: document.languageId,
  });

  const payload = {
    roadmap_id: activeTask.roadmap_id,
    milestone_id: activeTask.milestone_id,
    skillpath_id: activeTask.skillpath_id,
    code_context: contextCode,
    language: document.languageId,
    diagnostic_message: diagnosticMessage,
    pre_event_window: eventRecorder?.snapshot(),
  };

  try {
    const responseData = await reportStruggle(payload);

    // Anchor when the hint was shown — lets later analysis see whether the
    // user kept googling / the diagnostic persisted *after* the hint
    // (i.e. whether the hint actually helped).
    eventRecorder?.mark("hint_shown", {
      concept_name: responseData.concept_name,
    });

    return {
      ok: true,
      concept_id: responseData.concept_id,
      concept_name: responseData.concept_name,
      misconception: responseData.misconception,
      hint: responseData.hint,
    };
  } catch (error: any) {
    return { ok: false, reason: `Failed to get help: ${error.message}` };
  }
}
