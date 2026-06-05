import * as vscode from 'vscode';
import { SidebarViewProvider } from '../providers/SidebarProvider';
import { EventRecorder } from '../telemetry/EventRecorder';
import { captureStruggle } from './captureStruggle';
import { SidecarSessionManager } from '../sidecar/SidecarSessionManager';

export function registerReportStruggleCommand(
  provider: SidebarViewProvider,
  eventRecorder?: EventRecorder,
  sidecar?: SidecarSessionManager,
) {
  return vscode.commands.registerCommand("anti-copilot.reportStruggle", async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Sending Struggle Signal to AntiCopilot...",
        cancellable: false
      },
      async () => {
        const outcome = await captureStruggle(provider, eventRecorder);

        if (!outcome.ok) {
          vscode.window.showErrorMessage(outcome.reason);
          return;
        }

        // Display the hint using the sidebar provider
        provider.showHintNotif(outcome.hint ?? "", outcome.concept_name);

        // Mirror this user-initiated struggle to the sidecar (if a session is
        // live) so its session recap knows the concept was resolved here.
        // Fails soft — never blocks the hint the user is waiting on.
        if (outcome.concept_id) {
          sidecar?.registerAutoConcept({
            concept_id: outcome.concept_id,
            concept_name: outcome.concept_name,
            misconception: outcome.misconception,
            hint: outcome.hint,
          });
        }
      }
    );
  });
}
