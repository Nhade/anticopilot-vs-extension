import * as vscode from 'vscode';
import { getSidebarHtml } from '../views/sidebarHtml';
import {
  getDueReviews,
  generateTask,
  gradeReview,
  getRoadmap,
  generateSkillpathContent,
  SkillPath,
  RoadmapData,
  CodingProblemLearningContent,
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
): Promise<void> {
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
   * Fires whenever the active task is (re)set. The sidecar manager listens here
   * to start a telemetry session for the task the learner is working on.
   */
  private readonly _onDidChangeActiveTask = new vscode.EventEmitter<SkillPath>();
  public readonly onDidChangeActiveTask = this._onDidChangeActiveTask.event;

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
      await openCodingProblemInEditor(problem, this._activeTask?.title);
      return true;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open coding problem: ${err.message}`);
      return false;
    }
  }

  public showHintNotif(hint: string, conceptName?: string) {
    if (this._view) {
      this._view.webview.postMessage({ command: "showHint", hint, conceptName });
    } else {
      vscode.window.showInformationMessage(`AntiCopilot Hint: ${hint}`);
    }
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
            await openCodingProblemInEditor(problem, this._activeTask?.title);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open coding problem: ${err.message}`);
          }
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
              error: "Missing roadmap or skillpath identifier.",
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
            if (updatedSkillpath) {
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

    if (this._activeTask) {
      this.updateActiveTask(this._activeTask);
    }
  }
}
