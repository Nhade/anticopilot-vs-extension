import * as vscode from 'vscode';
import { SidebarViewProvider } from '../providers/SidebarProvider';
import {
  CodingProblemLearningContent,
  HintLevel,
  requestMemoryHint,
} from '../api/client';
import { captureStruggle, CaptureOutcome } from './captureStruggle';
import { EventRecorder } from '../telemetry/EventRecorder';
import { SidecarSessionManager } from '../sidecar/SidecarSessionManager';

/**
 * The single "I'm Stuck — Get a Hint" action (formerly two commands).
 *
 * Every ask returns a memory-aware, low-spoiler hint from the learner-memory
 * pipeline. The FIRST ask per problem is also treated as the real "I'm stuck"
 * moment: it reports a struggle signal in parallel, which creates the FSRS
 * review card, anchors the telemetry timeline, and mirrors the concept to the
 * sidecar recap. Escalation re-asks are not new struggles, so they stay
 * hint-only.
 */

// Escalate one level per repeated request on the same content, so a learner
// who keeps asking gets progressively more concrete help.
const HINT_LEVELS: HintLevel[] = ['nudge', 'conceptual', 'specific', 'near_solution'];
const hintLevelIndexByContent = new Map<string, number>();

// Double-submit guard: a duplicate click would fire a parallel request AND
// burn an escalation level, permanently skipping the gentler hint.
let hintRequestInFlight = false;

function peekHintLevel(key: string): { level: HintLevel; index: number } {
  const index = Math.min(hintLevelIndexByContent.get(key) ?? 0, HINT_LEVELS.length - 1);
  return { level: HINT_LEVELS[index], index };
}

export function registerRequestHintCommand(
  provider: SidebarViewProvider,
  eventRecorder?: EventRecorder,
  sidecar?: SidecarSessionManager,
) {
  return vscode.commands.registerCommand('anti-copilot.requestHint', async () => {
    if (hintRequestInFlight) {
      return; // first click's progress notification is already visible
    }
    const activeTask = provider.getActiveTask();
    if (!activeTask?.skillpath_id) {
      vscode.window.showErrorMessage(
        'Open a task from the AntiCopilot dashboard before asking for help — we need to know which task you are working on.',
      );
      return;
    }

    const problem = (activeTask.learning_contents ?? []).find(
      (c): c is CodingProblemLearningContent => c.content_type === 'coding_problem',
    );
    const taskPrompt = problem?.prompt ?? `${activeTask.title}: ${activeTask.description}`;

    const editor = vscode.window.activeTextEditor;
    const submittedCode = editor?.document.getText() ?? '';
    const language = editor?.document.languageId ?? 'python';

    // Surface current diagnostics so the hint can react to the actual error
    // the learner is staring at.
    let validationFeedback: string | undefined;
    if (editor) {
      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
      if (diagnostics.length > 0) {
        validationFeedback = diagnostics
          .slice(0, 5)
          .map((d) => `[Line ${d.range.start.line + 1}] ${d.message}`)
          .join('\n');
      }
    }

    const key = problem?.content_id ?? activeTask.skillpath_id;
    const { level, index } = peekHintLevel(key);

    hintRequestInFlight = true;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Asking AntiCopilot for help...',
          cancellable: false,
        },
        async () => {
          // Struggle report runs in parallel with the hint request — it must
          // never delay the hint the user is waiting on. captureStruggle
          // fails soft (returns { ok: false }) when there is no editor or the
          // task lacks full ids.
          const strugglePromise: Promise<CaptureOutcome | undefined> =
            level === 'nudge'
              ? captureStruggle(provider, eventRecorder).catch(() => undefined)
              : Promise.resolve(undefined);

          let hint: string | undefined;
          let hintError: string | undefined;
          try {
            const response = await requestMemoryHint({
              skillpath_id: activeTask.skillpath_id,
              content_id: problem?.content_id,
              task_prompt: taskPrompt,
              submitted_code: submittedCode,
              language,
              validation_feedback: validationFeedback,
              hint_level: level,
            });
            hint = response.hint;
            // Commit the escalation only on success — a failed request must
            // not permanently skip the gentler hint level.
            hintLevelIndexByContent.set(key, index + 1);
          } catch (error: any) {
            hintError = error.message;
          }

          const struggle = await strugglePromise;
          if (struggle?.ok && struggle.concept_id) {
            // Mirror to the sidecar (if a session is live) so its recap knows
            // the concept was resolved here. Fails soft.
            sidecar?.registerAutoConcept({
              concept_id: struggle.concept_id,
              concept_name: struggle.concept_name,
              misconception: struggle.misconception,
              hint: struggle.hint,
            });
          }

          if (hint) {
            // The memory hint is the primary help; the struggle's concept name
            // is what makes the "+ Added to your review queue" footer true.
            provider.showHintNotif(hint, struggle?.ok ? struggle.concept_name : undefined);
          } else if (struggle?.ok && struggle.hint) {
            // Memory hint failed but the struggle pipeline produced one.
            provider.showHintNotif(struggle.hint, struggle.concept_name);
          } else {
            vscode.window.showErrorMessage(`Failed to get help: ${hintError ?? 'unknown error'}`);
          }
        },
      );
    } finally {
      hintRequestInFlight = false;
    }
  });
}
