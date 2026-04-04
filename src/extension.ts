import { create } from "domain";
import * as vscode from "vscode";

// 1. Type Definition
type Hint = {
  start: { line: number; character: number };
  originalError: string;
  hint: string;
};

// 2. The HTML Skeleton
function getWebviewContent() {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Anti-Copilot</title>
    <style>
      body { font-family: var(--vscode-font-family); padding: 10px; }
      .hint-item { margin-bottom: 15px; padding: 10px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 5px;}
      .line-info { font-weight: bold; color: var(--vscode-textLink-foreground); }
    </style>
  </head>
  <body>
    <h2>Anti-Copilot Diagnostics</h2>
    <ul id="hint-list" style="list-style-type: none; padding: 0;">
      </ul>

    <script>
      const ul = document.getElementById('hint-list');

      // Listen for messages sent from the extension
      window.addEventListener('message', event => {
        const message = event.data;
        
        if (message.command === 'addHint') {
          const data = message.data;
          
          // Create a new list item for the hint
          const li = document.createElement('li');
          li.className = 'hint-item';
          
          // Add 1 to the line number because VS Code's API is 0-indexed, but users read 1-indexed
          li.innerHTML = \`
            <div class="line-info">Line \${data.start.line + 1}, Col \${data.start.character}</div>
            <div style="font-size: 0.9em; opacity: 0.8; margin-bottom: 5px;">\${data.originalError}</div>
            <div>\${data.hint}</div>
          \`;
          
          ul.appendChild(li);
        }
      });
    </script>
  </body>
  </html>
  `;
}

// The "Highlight" decoration
const diagnosticsHighlightDecoration =
  vscode.window.createTextEditorDecorationType({
    border: "1px solid oklch(0.8118 0.15 73.74)",
    borderRadius: "6px",
    backgroundColor: "oklch(0.8118 0.15 73.74/40%)",
  });

export function activate(context: vscode.ExtensionContext) {
  let currentPanel: vscode.WebviewPanel | undefined = undefined;

  const createPrintDiagnosticsCommand = vscode.commands.registerCommand(
    "anti-copilot.printDiagnostics",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active editor found.");
        return;
      }

      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
      const text = editor.document.getText().split("\n");

      if (diagnostics.length === 0) {
        vscode.window.showInformationMessage("No diagnostics found!");
        return;
      }

      // 3.   Create or reveal the Webview
      if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
      } else {
        currentPanel = vscode.window.createWebviewPanel(
          "antiCopilot",
          "Anti-Copilot Hints",
          vscode.ViewColumn.Beside,
          { enableScripts: true },
        );

        // Load the static HTML shell
        currentPanel.webview.html = getWebviewContent();

        // Reset the panel reference when the user closes it
        currentPanel.onDidDispose(
          () => {
            currentPanel = undefined;
          },
          null,
          context.subscriptions,
        );
      }

      // 4. Process each diagnostic
      diagnostics.forEach(async (d) => {
        let contextStart = Math.max(d.range.start.line - 3, 0);
        let contextEnd = Math.min(d.range.end.line + 3, text.length);
        const codeContext = text.slice(contextStart, contextEnd).join("\n");

        try {
          const response = await fetch("http://localhost:8000/v1/signals/struggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              roadmap_id: "current-roadmap", // Placeholder for actual ID from context
              milestone_id: "current-milestone", // Placeholder
              skillpath_id: "current-task", // Placeholder
              code_context: codeContext,
              diagnostic_message: d.message,
            }),
          });

          if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
          }

          const responseData = (await response.json()) as { hint: string };

          const hintPayload: Hint = {
            start: {
              line: d.range.start.line,
              character: d.range.start.character,
            },
            originalError: d.message,
            hint: responseData.hint,
          };

          // 5. Send the data to the Webview to be rendered
          currentPanel?.webview.postMessage({
            command: "addHint",
            data: hintPayload,
          });
        } catch (e) {
          console.error("Failed to fetch hint for line", d.range.start.line, e);
        }
      });
    },
  );

  const createHighlightDiagnosticsCommand = vscode.commands.registerCommand(
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

      // 4. Process each diagnostic
      const regions = diagnostics.map((d) => {
        return new vscode.Range(
          d.range.start.line,
          d.range.start.character,
          d.range.end.line,
          d.range.end.character,
        );
      });
      editor.setDecorations(diagnosticsHighlightDecoration, regions);
    },
  );

  const createOpenSidebarCommand = vscode.commands.registerCommand(
    "anti-copilot.openSidebar",
    () => {
      currentPanel = vscode.window.createWebviewPanel(
        "sidebar",
        "Test Sidebar",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
        },
      );
      currentPanel.webview.html = `
        <!doctype html>
        <html lang="en">
          <head>
            <style>
              p {
                font-weight: 500;
              }
              h2 {
                text-align: center;
              }
              body {
                font-family: var(--vscode-font-family);
                margin: 0px;
                padding: 0px;
                background-color: oklch(0.9571 0.01 73.74);
                color: hsla(0, 0%, 0%, 0.87);
              }
              img {
                border-radius: 50%;
                border: 1px solid;
              }
              nav {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: medium;
                background-color: oklch(0.8118 0.15 73.74);
                padding: 6px 15px 6px 15px;
                border-radius: 0px 0px 15px 15px;
                box-shadow: 0 0 10px hsla(0, 0%, 0%, 0.15);
              }
              button {
                background-color: oklch(0.5873 0.2156 265.65);
                padding: 5px 15px 5px 15px;
                border-radius: 6px;
                border: none;
                color: hsla(0, 100%, 100%, 0.87);
                cursor: pointer;
                &:hover {
                  scale: 1.02;
                  box-shadow: 0 0 5px oklch(0.5873 0.2156 265.65);
                }
                transition: all 0.15s ease-in-out;
              }
              .highlight {
                color: oklch(0.5873 0.2156 265.65);
                font-weight: 600;
                font-size: large;
              }
              .notification {
                display: flex;
                justify-content: space-between;
                align-items: center;
                /* background-color: oklch(0.8118 0.15 73.74); */
                background-color: oklch(0.9571 0.01 73.74);
                box-shadow: 0 0 12px hsla(0, 0%, 0%, 0.15);
                padding: 15px;
                border-radius: 6px;
                position: absolute;
                top: 80px;
                right: -200px;
                z-index: 99;
                gap: 15px;
                transition: all 0.15s ease-in-out;
              }
              .nav-item {
                display: flex;
                align-items: center;
              }
              .title {
                font-size: medium;
                font-weight: 600;
                margin-right: 5px;
              }
              .module-list {
                display: flex;
                flex-direction: column;
                gap: 15px;
                margin: 15px;
              }
              .module-card {
                padding: 15px;
                border-radius: 6px;
                background: oklch(0.8118 0.15 73.74);
                color: hsla(0, 0%, 0%, 0.87);
                box-shadow: 0 0 12px hsla(0, 0%, 0%, 0.15);
              }
              .module-list .intro {
                box-shadow: 0 0 10px hsla(0, 0%, 0%, 0.15);
                background-color: oklch(0.5873 0.2156 265.65/40%);
              }
              .module-list .challenge {
                box-shadow: 0 0 10px hsla(0, 0%, 0%, 0.3);
                border: 1px solid oklch(0.9571 0.01 73.74);
                background-color: oklch(0.8118 0.15 73.74);
              }
              .locked {
                opacity: 0.5;
                pointer-events: none;
              }
            </style>
          </head>
          <body>
            <nav>
              <div class="nav-item">🔥 <span class="highlight">14</span></div>
              <div class="nav-item">⚡ <span class="highlight">250</span> XP</div>
              <div class="nav-item">📆 <span class="highlight">3/5</span> Lessons</div>
            </nav>

            <h2>Lesson 3: Event Listeners</h2>

            <div class="module-list">
              <div class="module-card intro">
                <h3>Listening for Action</h3>
                <p>
                  Webpages are interactive. To make things happen when a user clicks a
                  button or types in a field, we use Event Listeners.
                </p>
                <p>⏷ Expand example</p>
              </div>

              <div class="module-card challenge">
                <h3>🎯 Your Turn</h3>
                <p>
                  In <code>app.js</code>, there is a button with the ID
                  <code>theme-toggle</code>.
                </p>
                <p>1. Select the button and store it in a variable.</p>
                <p>2. Add an event listener to it that listens for a 'click'.</p>
                <p>
                  3. Inside the event listener, log "Theme switched!" to the console.
                </p>
              </div>
            </div>

            <div class="notification">
              <span>Need a hint?</span>
              <button>Get Hint</button>
            </div>

            <script>
              const notification = document.querySelector(".notification");
              const hintButton = document.querySelector(".notification button");

              window.addEventListener("message", (event) => {
                const message = event.data;

                switch (message.command) {
                  case "hint":
                    notification.style.right = "15px";
                    setTimeout(() => {
                      notification.style.right = "-200px";
                    }, 5000);
                    break;
                }
              });
            </script>
          </body>
        </html>
      `;
    },
  );

  const createIncrementCommand = vscode.commands.registerCommand(
    "anti-copilot.increment",
    () => {
      currentPanel?.webview.postMessage({
        command: "Increment",
      });
    },
  );

  const createTestFetchCommand = vscode.commands.registerCommand(
    "anti-copilot.testFetch",
    async () => {
      try {
        const response = await fetch("https://jsonplaceholder.typicode.com/todos/1");
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        vscode.window.showInformationMessage(`Fetch success: ${JSON.stringify(data)}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Fetch failed: ${e.message}`);
      }
    },
  );

  let timesEdited = 0;
  let lastEditedTimestamp = 0;
  let hintTimeout: NodeJS.Timeout | undefined;

  vscode.workspace.onDidChangeTextDocument(
    (event) => {
      if (hintTimeout) {
        // Reset timeout on edit
        clearTimeout(hintTimeout);
      }

      // Since `onDidChangeTextDocument` triggers without cooldown, we combine temporally close edits into one
      // Check if time interval between this edit and last has surpassed certain threshold
      const now = Date.now();
      if (now - lastEditedTimestamp > 2000) {
        timesEdited++;
      }

      // Triggers a timeout after three edits are done
      if (timesEdited >= 3) {
        hintTimeout = setTimeout(() => {
          // vscode.window.showInformationMessage("Need a hint?");
          currentPanel?.webview.postMessage({
            command: "hint",
          });
          // Shows hint in sidebar to demo message passing
          // provider.showHintNotif();
          timesEdited = 0;
          hintTimeout = undefined;
        }, 2000);
      }
      lastEditedTimestamp = now;
    },
    null,
    context.subscriptions,
  );

  const provider = new SidebarViewProvider(context.extensionUri);

  // URI Handler for "open-task"
  const uriHandler = vscode.window.registerUriHandler({
    async handleUri(uri: vscode.Uri) {
      if (uri.path === "/open-task") {
        const queryParams = new URLSearchParams(uri.query);
        const roadmapId = queryParams.get("roadmapId");
        const taskId = queryParams.get("taskId");

        if (roadmapId && taskId) {
          vscode.window.showInformationMessage(`Opening task: ${taskId}`);
          
          try {
            const response = await fetch(`http://localhost:8000/v1/roadmaps/${roadmapId}`);
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`Backend error (${response.status}): ${errorText}`);
            }
            const data = (await response.json()) as any;
            
            // Find the specific task in the roadmap data
            const normTaskId = taskId.trim().toLowerCase();
            const skillpath = (data.skillpaths || []).find((s: any) => {
              const sId = String(s.skillpath_id || "").trim().toLowerCase();
              const sTitle = String(s.title || "").trim().toLowerCase();
              return sId === normTaskId || sTitle === normTaskId;
            });
            
            if (skillpath) {
              provider.updateActiveTask(skillpath);
              vscode.commands.executeCommand("anti-copilot.sidebar.focus");
            } else {
              vscode.window.showErrorMessage(`Task "${taskId}" not found in roadmap "${roadmapId}".`);
            }
          } catch (error: any) {
            vscode.window.showErrorMessage(`Connection Error: ${error.message}. Is the backend running on port 8000?`);
          }
        }
      }
    }
  });

  context.subscriptions.push(
    createPrintDiagnosticsCommand,
    createHighlightDiagnosticsCommand,
    createOpenSidebarCommand,
    createIncrementCommand,
    createTestFetchCommand,
    uriHandler,
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      provider,
    ),
  );
}

class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "anti-copilot.sidebar";

  private _view?: vscode.WebviewView;
  private _activeTask?: any;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public updateActiveTask(task: any) {
    this._activeTask = task;
    if (this._view) {
      this._view.webview.postMessage({ command: "updateTask", task });
    }
  }

  public showHintNotif() {
    this._view?.webview.postMessage({ command: "hint" });
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

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "alert": {
          vscode.window.showInformationMessage("owo");
          break;
        }
      }
    });

    // If there's already an active task, send it to the webview
    if (this._activeTask) {
      this.updateActiveTask(this._activeTask);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const activeColor = "oklch(0.78 0.08 198)";
    const bgColor = "oklch(0.145 0 0)";
    const fgColor = "oklch(0.985 0 0)";

    return `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              :root {
                --active-color: ${activeColor};
                --bg-color: ${bgColor};
                --fg-color: ${fgColor};
                --card-bg: rgba(255, 255, 255, 0.03);
                --card-border: rgba(255, 255, 255, 0.08);
              }

              body {
                font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
                margin: 0;
                padding: 16px;
                background-color: var(--vscode-sideBar-background, var(--bg-color));
                color: var(--vscode-sideBar-foreground, var(--fg-color));
                overflow-x: hidden;
                line-height: 1.5;
              }

              /* Hide scrollbar */
              body::-webkit-scrollbar { display: none; }
              body { -ms-overflow-style: none; scrollbar-width: none; }

              .container {
                display: flex;
                flex-direction: column;
                gap: 20px;
                animation: fadeIn 0.4s ease-out;
              }

              @keyframes fadeIn {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: translateY(0); }
              }

              .header {
                display: flex;
                flex-direction: column;
                gap: 8px;
              }

              .badge {
                display: inline-flex;
                align-items: center;
                padding: 4px 10px;
                border-radius: 100px;
                background: rgba(125, 211, 252, 0.1);
                color: var(--active-color);
                font-size: 10px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.1em;
                border: 1px solid rgba(125, 211, 252, 0.2);
                width: fit-content;
              }

              .title {
                font-size: 20px;
                font-weight: 700;
                letter-spacing: -0.02em;
                margin: 0;
                color: var(--fg-color);
              }

              .card {
                background: var(--card-bg);
                border: 1px solid var(--card-border);
                border-radius: 12px;
                padding: 16px;
                backdrop-filter: blur(10px);
                display: flex;
                flex-direction: column;
                gap: 12px;
                transition: border-color 0.2s ease;
              }

              .card:hover {
                border-color: rgba(125, 211, 252, 0.3);
              }

              .section-label {
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                color: rgba(255, 255, 255, 0.4);
                letter-spacing: 0.05em;
              }

              .objective-text {
                font-size: 13px;
                color: rgba(255, 255, 255, 0.8);
                margin: 0;
              }

              .criteria-list {
                display: flex;
                flex-direction: column;
                gap: 10px;
              }

              .criteria-item {
                display: flex;
                align-items: flex-start;
                gap: 10px;
                font-size: 12px;
                color: rgba(255, 255, 255, 0.7);
              }

              .checkbox {
                width: 14px;
                height: 14px;
                border-radius: 4px;
                border: 1px solid rgba(255, 255, 255, 0.2);
                margin-top: 2px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
              }

              .checkbox.checked {
                background: var(--active-color);
                border-color: var(--active-color);
              }

              .checkbox.active {
                border-color: var(--active-color);
                box-shadow: 0 0 8px rgba(125, 211, 252, 0.3);
              }

              .loading {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 200px;
                gap: 16px;
                color: rgba(255, 255, 255, 0.3);
              }

              .spinner {
                width: 24px;
                height: 24px;
                border: 2px solid rgba(255, 255, 255, 0.1);
                border-top-color: var(--active-color);
                border-radius: 50%;
                animation: spin 1s linear infinite;
              }

              @keyframes spin {
                to { transform: rotate(360deg); }
              }

              .empty-state {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                text-align: center;
                padding: 40px 20px;
                color: rgba(255, 255, 255, 0.4);
                gap: 12px;
              }

              .empty-state svg {
                width: 40px;
                height: 40px;
                opacity: 0.2;
              }
            </style>
          </head>
          <body>
            <div id="app" class="container">
              <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M12 8V12L15 15" stroke-linecap="round" stroke-linejoin="round"/>
                  <circle cx="12" cy="12" r="9"/>
                </svg>
                <div style="font-size: 14px; font-weight: 600;">No Active Task</div>
                <div style="font-size: 12px; opacity: 0.8;">Select a task from the dashboard to focus on your progress.</div>
              </div>
            </div>

            <script>
              const app = document.getElementById('app');
              
              window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                  case 'updateTask':
                    renderTask(message.task);
                    break;
                }
              });

              function renderTask(task) {
                if (!task) return;
                
                app.innerHTML = \`
                  <div class="header">
                    <div class="badge">Active Task</div>
                    <h1 class="title">\${task.title}</h1>
                  </div>

                  <div class="card">
                    <div class="section-label">Objective</div>
                    <p class="objective-text">\${task.description || 'No description available for this task.'}</p>
                  </div>

                  <div class="card">
                    <div class="section-label">Success Criteria</div>
                    <div class="criteria-list">
                      \${(task.learning_objectives || []).map((obj, i) => \`
                        <div class="criteria-item">
                          <div class="checkbox \${i === 0 ? 'active' : ''}"></div>
                          <span>\${obj}</span>
                        </div>
                      \`).join('')}
                      \${(!task.learning_objectives || task.learning_objectives.length === 0) ? \`
                         <div class="criteria-item">
                          <div class="checkbox active"></div>
                          <span>Implement task requirements</span>
                        </div>
                      \` : ''}
                    </div>
                  </div>

                  <div style="margin-top: auto; padding-top: 20px;">
                     <div class="section-label" style="text-align: center; margin-bottom: 8px;">Convergence Signal</div>
                     <div style="font-size: 11px; text-align: center; color: rgba(255,255,255,0.3);">
                        VS Code is now synced with your AntiCopilot roadmap.
                     </div>
                  </div>
                \`;
              }
            </script>
          </body>
        </html>
      `;
  }
}

export function deactivate() {}
