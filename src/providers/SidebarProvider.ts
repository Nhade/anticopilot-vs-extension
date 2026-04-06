import * as vscode from 'vscode';
import { getSidebarHtml } from '../views/sidebarHtml';
import { getDueReviews, generateTask, gradeReview, getRoadmap } from '../api/client';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "anti-copilot.sidebar";

  private _view?: vscode.WebviewView;
  private _activeTask?: any;
  private _activeRoadmapId?: string;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public getActiveTask(): any {
    return this._activeTask;
  }

  public updateActiveTask(task: any, roadmapId?: string, roadmapData?: any) {
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
  }

  public showHintNotif(hint: string, conceptName?: string) {
    if (this._view) {
      this._view.webview.postMessage({ command: "showHint", hint, conceptName });
    } else {
      vscode.window.showInformationMessage(`AntiCopilot Hint: ${hint}`);
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
      }
    });

    if (this._activeTask) {
      this.updateActiveTask(this._activeTask);
    }
  }
}
