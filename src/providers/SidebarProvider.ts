import * as vscode from 'vscode';
import { getSidebarHtml } from '../views/sidebarHtml';
import {
  getDueReviews,
  generateTask,
  gradeReview,
  getRoadmap,
  generateSkillpathContent,
  submitCodeAttempt,
  updateSkillpathStatus,
  SkillPath,
  RoadmapData,
  CodingProblemLearningContent,
  CodeSubmissionResult,
} from '../api/client';

function detectLanguage(code: string): string {
  if (!code) {
    return 'plaintext';
  }
  const sample = code.slice(0, 800);
  if (/^\s*(#!.*python|from\s+[\w.]+\s+import|import\s+\w+|def\s+\w+\s*\(|if\s+__name__\s*==)/m.test(sample)) {
    return 'python';
  }
  if (/^\s*#include\s*<[\w./]+\.h(pp|xx)?>/m.test(sample) || /\busing\s+namespace\s+\w+/.test(sample) || /\bstd::/.test(sample)) {
    return 'cpp';
  }
  if (/^\s*#include\s*<[\w./]+\.h>/m.test(sample)) {
    return 'c';
  }
  if (/^\s*package\s+[\w.]+\s*;|public\s+(class|interface|enum)\s+\w+/m.test(sample)) {
    return 'java';
  }
  if (/^\s*package\s+\w+\s*$|^\s*func\s+\w+\s*\(/m.test(sample)) {
    return 'go';
  }
  if (/^\s*(fn\s+\w+\s*\(|let\s+mut\s+|use\s+std::)/m.test(sample)) {
    return 'rust';
  }
  if (/^\s*(interface\s+\w+|type\s+\w+\s*=|:\s*(string|number|boolean)\b)/m.test(sample)) {
    return 'typescript';
  }
  if (/^\s*(function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|console\.log|=>\s*\{)/m.test(sample)) {
    return 'javascript';
  }
  return 'plaintext';
}

async function openCodingProblemInEditor(
  problem: CodingProblemLearningContent,
  taskTitle?: string,
): Promise<vscode.TextDocument> {
  const starter = problem.starter_code || '';
  const language = detectLanguage(starter);
  const header = `// ${taskTitle ? taskTitle + ' — ' : ''}${problem.title || 'Coding Problem'}\n`;
  const commentPrefix = language === 'python' ? '# ' : '// ';
  const banner = header.replace(/^\/\/ /, commentPrefix);
  const body = banner + '\n' + starter;
  const doc = await vscode.workspace.openTextDocument({ language, content: body });
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  });
  return doc;
}

function findCodingProblem(
  task: SkillPath | undefined,
  contentId?: string,
): CodingProblemLearningContent | undefined {
  if (!task || !Array.isArray(task.learning_contents)) {
    return undefined;
  }
  const codingProblems = task.learning_contents.filter(
    (c): c is CodingProblemLearningContent => c.content_type === 'coding_problem' && !!c.starter_code,
  );
  if (contentId) {
    return codingProblems.find((c) => c.content_id === contentId);
  }
  return codingProblems[0];
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "anti-copilot.sidebar";

  private _view?: vscode.WebviewView;
  private _activeTask?: SkillPath;
  private _activeRoadmapId?: string;

  /**
   * Untitled editor documents created per coding problem, so submission can
   * retrieve the learner's code even when the sidebar webview holds focus
   * (activeTextEditor is only the fallback).
   */
  private readonly _problemDocs = new Map<string, vscode.TextDocument>();
  private readonly _submittingContentIds = new Set<string>();

  /**
   * Fires whenever the active task is (re)set. The sidecar manager listens here
   * to start a telemetry session for the task the learner is working on.
   */
  private readonly _onDidChangeActiveTask = new vscode.EventEmitter<SkillPath>();
  public readonly onDidChangeActiveTask = this._onDidChangeActiveTask.event;

  /**
   * Fires after the user confirms completion AND the status write succeeded.
   * The sidecar listens here to end the task's live session.
   */
  private readonly _onDidCompleteTask = new vscode.EventEmitter<SkillPath>();
  public readonly onDidCompleteTask = this._onDidCompleteTask.event;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public getActiveTask(): SkillPath | undefined {
    return this._activeTask;
  }

  public updateActiveTask(task: SkillPath, roadmapId?: string, roadmapData?: RoadmapData) {
    this._activeTask = task;
    if (roadmapId) {
      this._activeRoadmapId = roadmapId;
    }
    if (this._view) {
      this._view.webview.postMessage({ command: "updateTask", task, roadmapId });
      if (roadmapData) {
        this._view.webview.postMessage({ command: "roadmapData", roadmap: roadmapData });
      }
    }
    this._onDidChangeActiveTask.fire(task);
  }

  public async openActiveCodingProblem(): Promise<boolean> {
    const problem = findCodingProblem(this._activeTask);
    if (!problem) {
      return false;
    }
    try {
      await this.openOrRevealProblemDoc(problem);
      return true;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open coding problem: ${err.message}`);
      return false;
    }
  }

  /**
   * Reveal the learner's existing editor for this problem instead of
   * recreating it — re-opening (deep link, second button click) must never
   * replace the tracked doc with pristine starter code, or Submit would
   * silently send the wrong content.
   */
  private async openOrRevealProblemDoc(problem: CodingProblemLearningContent): Promise<void> {
    const existing = this._problemDocs.get(problem.content_id);
    if (existing && !existing.isClosed) {
      await vscode.window.showTextDocument(existing, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      return;
    }
    const doc = await openCodingProblemInEditor(problem, this._activeTask?.title);
    this._problemDocs.set(problem.content_id, doc);
  }

  /**
   * Submit the learner's current code for the active coding problem through
   * the full backend pipeline (validator agent + memory consolidation).
   * Shared by the webview Submit button and the command palette.
   */
  public async submitActiveCodingProblem(contentId?: string): Promise<void> {
    const task = this._activeTask;
    // Unlike findCodingProblem (open-in-editor), submission does not require
    // starter_code — the learner may write their solution in any editor.
    const problem = (task?.learning_contents ?? []).find(
      (c): c is CodingProblemLearningContent =>
        c.content_type === 'coding_problem' && (!contentId || c.content_id === contentId),
    );
    if (!task?.skillpath_id || !problem) {
      vscode.window.showWarningMessage(
        'No active coding problem to submit. Open a task from the AntiCopilot sidebar first.',
      );
      if (contentId) {
        // Unstick the webview's pending state if the click raced a task change.
        this.postSubmissionResult(contentId, {
          success: false,
          error: 'This coding problem is no longer part of the active task.',
        });
      }
      return;
    }
    if (this._submittingContentIds.has(problem.content_id)) {
      return; // in-flight; the progress notification is already visible
    }

    const tracked = this._problemDocs.get(problem.content_id);
    const doc = tracked && !tracked.isClosed ? tracked : vscode.window.activeTextEditor?.document;
    if (!doc) {
      this.postSubmissionResult(problem.content_id, {
        success: false,
        error: problem.starter_code
          ? 'No editor with your solution is open. Use "Open Starter Code in Editor" first.'
          : 'No editor with your solution is open. Open the file with your solution, focus it, then submit again.',
      });
      return;
    }
    // Error-severity diagnostics are caller-supplied compile evidence; the
    // validator weighs real evidence higher than static reasoning.
    const errors = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 5);
    const compileError = errors.length
      ? errors.map((d) => `[Line ${d.range.start.line + 1}] ${d.message}`).join('\n')
      : undefined;

    this._submittingContentIds.add(problem.content_id);
    // Webview click already set its pending state; this covers the palette path.
    this._view?.webview.postMessage({ command: 'submissionPending', contentId: problem.content_id });
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AntiCopilot is validating your solution…',
          cancellable: false,
        },
        async () => {
          try {
            const result = await submitCodeAttempt({
              skillpath_id: task.skillpath_id,
              content_id: problem.content_id,
              language: doc.languageId,
              coding_problem_prompt: problem.prompt || `${task.title}: ${task.description}`,
              submitted_code: doc.getText(),
              starter_code: problem.starter_code ?? undefined,
              expected_output: problem.expected_output ?? undefined,
              compile_error: compileError,
            });
            this.postSubmissionResult(problem.content_id, { success: true, result });
          } catch (err: any) {
            this.postSubmissionResult(problem.content_id, { success: false, error: err.message });
          }
        },
      );
    } finally {
      this._submittingContentIds.delete(problem.content_id);
    }
  }

  private postSubmissionResult(
    contentId: string,
    outcome: { success: boolean; result?: CodeSubmissionResult; error?: string },
  ) {
    if (this._view) {
      // Same pattern as showHintNotif: never post the verdict into a hidden
      // webview (palette-invoked submissions would finish invisibly).
      if (!this._view.visible) {
        this._view.show(true);
      }
      this._view.webview.postMessage({ command: 'submissionResult', contentId, ...outcome });
    } else if (outcome.success && outcome.result) {
      vscode.window.showInformationMessage(
        `AntiCopilot verdict: ${outcome.result.validation.correctness} — ${outcome.result.validation.feedback_summary}`,
      );
    } else {
      vscode.window.showErrorMessage(`AntiCopilot submission failed: ${outcome.error ?? 'unknown error'}`);
    }
  }

  /**
   * Mark the active skillpath completed (user-confirmed after a correct
   * submission — never automatic, since web-side completion semantics are
   * "all lessons marked", not "one coding problem solved").
   */
  public async completeActiveTask(): Promise<void> {
    const task = this._activeTask;
    const roadmapId = task?.roadmap_id || this._activeRoadmapId;
    if (!task?.skillpath_id || !roadmapId) {
      this._view?.webview.postMessage({
        command: 'completeResult',
        success: false,
        error: 'No roadmap is loaded for this task.',
      });
      return;
    }
    try {
      const roadmap = await updateSkillpathStatus(roadmapId, task.skillpath_id, 'completed');
      const refreshed = (roadmap.milestones || [])
        .flatMap((m) => m.skillpaths || [])
        .find((sp) => sp.skillpath_id === task.skillpath_id);
      // Re-check after the await: if the user switched tasks mid-flight,
      // adopting the refreshed (completed) task would hijack the new one and
      // restart the sidecar session — same guard as generateSkillpathContent.
      if (refreshed && this._activeTask?.skillpath_id === task.skillpath_id) {
        this.updateActiveTask({ ...refreshed, roadmap_id: roadmapId }, roadmapId, roadmap);
      } else {
        this._view?.webview.postMessage({ command: 'roadmapData', roadmap });
      }
      // After updateActiveTask, so the sidecar's same-task guard has already
      // ignored the task-change re-fire; listeners that end the session for
      // THIS task act last and won't be re-opened by it.
      this._onDidCompleteTask.fire(task);
      this._view?.webview.postMessage({ command: 'completeResult', success: true });
    } catch (err: any) {
      this._view?.webview.postMessage({ command: 'completeResult', success: false, error: err.message });
    }
  }

  public showHintNotif(hint: string, conceptName?: string) {
    if (this._view) {
      // With retainContextWhenHidden the view stays resolved even when another
      // sidebar is showing — reveal it so the hint isn't posted into a hidden
      // webview (preserveFocus keeps the editor focused).
      if (!this._view.visible) {
        this._view.show(true);
      }
      this._view.webview.postMessage({ command: "showHint", hint, conceptName });
    } else {
      vscode.window.showInformationMessage(`AntiCopilot Hint: ${hint}`);
    }
  }

  /** Switch the sidebar webview to the Task tab (used by deep links). */
  public revealTaskTab() {
    this._view?.webview.postMessage({ command: "switchTab", tab: "task" });
  }

  /**
   * Refetch the cached roadmap and re-resolve the active skillpath from it.
   * Used as a cheap sync primitive when something outside the extension (the
   * web app, future validator agent) may have updated state — typically called
   * on window focus or when the Task tab opens with empty learning_contents.
   *
   * Silent on failure; the existing webview render keeps showing whatever
   * was already cached.
   */
  public async refreshActiveRoadmap(): Promise<void> {
    if (!this._activeRoadmapId) {
      return;
    }
    try {
      const data = await getRoadmap(this._activeRoadmapId);
      const activeId = this._activeTask?.skillpath_id;
      const refreshed = activeId
        ? (data.milestones || [])
            .flatMap((m) => m.skillpaths || [])
            .find((sp) => sp.skillpath_id === activeId)
        : undefined;
      if (refreshed) {
        this.updateActiveTask(
          { ...refreshed, roadmap_id: this._activeRoadmapId },
          this._activeRoadmapId,
          data
        );
      } else if (this._view) {
        // Skillpath disappeared (deleted, regen, etc.) — at least refresh the
        // roadmap tab data so the user can pick a new task.
        this._view.webview.postMessage({ command: "roadmapData", roadmap: data });
      }
    } catch (err) {
      console.error("Failed to refresh active roadmap:", err);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = getSidebarHtml(webviewView.webview, this._extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "webviewReady": {
          // Ready handshake: replay state only after the webview's message
          // listener exists, so an early postMessage is never dropped.
          if (this._activeTask) {
            this.updateActiveTask(this._activeTask, this._activeRoadmapId);
          }
          break;
        }
        case "fetchDueReviews": {
          try {
            const reviews = await getDueReviews();
            webviewView.webview.postMessage({ command: "dueReviews", reviews });
          } catch (err: any) {
            webviewView.webview.postMessage({ command: "dueReviews", reviews: [], error: err.message });
          }
          break;
        }
        case "generateTask": {
          try {
            const task = await generateTask(message.conceptId);
            webviewView.webview.postMessage({ command: "practiceTask", conceptId: message.conceptId, task });
          } catch (err: any) {
            webviewView.webview.postMessage({ command: "practiceTask", conceptId: message.conceptId, error: err.message });
          }
          break;
        }
        case "gradeReview": {
          try {
            await gradeReview(message.conceptId, message.grade);
            webviewView.webview.postMessage({ command: "gradeResult", conceptId: message.conceptId, success: true });
          } catch (err: any) {
            webviewView.webview.postMessage({ command: "gradeResult", conceptId: message.conceptId, success: false, error: err.message });
          }
          break;
        }
        case "fetchRoadmap": {
          const roadmapId = this._activeRoadmapId;
          if (!roadmapId) {
            webviewView.webview.postMessage({ command: "roadmapData", error: "No roadmap loaded. Open a task from the dashboard first." });
            break;
          }
          try {
            const data = await getRoadmap(roadmapId);
            webviewView.webview.postMessage({ command: "roadmapData", roadmap: data });
          } catch (err: any) {
            webviewView.webview.postMessage({ command: "roadmapData", error: err.message });
          }
          break;
        }
        case "setActiveTask": {
          this.updateActiveTask(message.task, message.task?.roadmap_id);
          webviewView.webview.postMessage({ command: "switchTab", tab: "task" });
          break;
        }
        case "refreshActiveTask": {
          await this.refreshActiveRoadmap();
          break;
        }
        case "openCodingProblem": {
          const problem = findCodingProblem(this._activeTask, message.contentId);
          if (!problem) {
            vscode.window.showWarningMessage("No coding problem with starter code is available for this task.");
            break;
          }
          try {
            await this.openOrRevealProblemDoc(problem);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open coding problem: ${err.message}`);
          }
          break;
        }
        case "requestHint": {
          // Delegate to the command so the webview button and the command
          // palette share one implementation (incl. hint-level escalation).
          await vscode.commands.executeCommand("anti-copilot.requestHint");
          break;
        }
        case "submitSolution": {
          // Same delegation pattern as requestHint.
          await vscode.commands.executeCommand("anti-copilot.submitSolution", message.contentId);
          break;
        }
        case "completeTask": {
          await this.completeActiveTask();
          break;
        }
        case "generateSkillpathContent": {
          const roadmapId: string | undefined = message.roadmapId || this._activeRoadmapId;
          const skillpathId: string | undefined = message.skillpathId;
          if (!roadmapId || !skillpathId) {
            webviewView.webview.postMessage({
              command: "skillpathContentResult",
              skillpathId,
              success: false,
              error: "Missing roadmap or task identifier.",
            });
            break;
          }
          try {
            const result = await generateSkillpathContent(roadmapId, skillpathId, {
              force: Boolean(message.force),
            });
            const updatedSkillpath = (result.roadmap.milestones || [])
              .flatMap((m) => m.skillpaths || [])
              .find((sp) => sp.skillpath_id === skillpathId);
            // Only adopt the generated skillpath when it already IS the active
            // task — generating from the Roadmap tab for another skillpath must
            // not silently switch the active task (and restart the sidecar
            // session); the user selects it explicitly via setActiveTask.
            if (updatedSkillpath && updatedSkillpath.skillpath_id === this._activeTask?.skillpath_id) {
              this.updateActiveTask(
                { ...updatedSkillpath, roadmap_id: roadmapId },
                roadmapId,
                result.roadmap
              );
            } else {
              webviewView.webview.postMessage({ command: "roadmapData", roadmap: result.roadmap });
            }
            webviewView.webview.postMessage({
              command: "skillpathContentResult",
              skillpathId,
              success: true,
            });
          } catch (err: any) {
            webviewView.webview.postMessage({
              command: "skillpathContentResult",
              skillpathId,
              success: false,
              error: err.message,
            });
          }
          break;
        }
      }
    });
  }
}
