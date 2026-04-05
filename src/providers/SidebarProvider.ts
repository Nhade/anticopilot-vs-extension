import * as vscode from 'vscode';
import { getSidebarHtml } from '../views/sidebarHtml';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "anti-copilot.sidebar";

  private _view?: vscode.WebviewView;
  private _activeTask?: any;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public getActiveTask(): any {
    return this._activeTask;
  }

  public updateActiveTask(task: any) {
    this._activeTask = task;
    if (this._view) {
      this._view.webview.postMessage({ command: "updateTask", task });
    }
  }

  public showHintNotif(hint: string) {
    if (this._view) {
      this._view.webview.postMessage({ command: "showHint", hint });
    } else {
      vscode.window.showInformationMessage(`AntiCopilot Hint: ${hint}`);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = getSidebarHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "alert": {
          vscode.window.showInformationMessage("owo");
          break;
        }
      }
    });

    if (this._activeTask) {
      this.updateActiveTask(this._activeTask);
    }
  }
}
