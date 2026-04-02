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

  context.subscriptions.push(
    createPrintDiagnosticsCommand,
    createHighlightDiagnosticsCommand,
    createOpenSidebarCommand,
    createIncrementCommand,
    createTestFetchCommand,
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      provider,
    ),
  );
}

class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "anti-copilot.sidebar";

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
  }
  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <style>
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
                background-color: oklch(0.8118 0.15 73.74);
                padding: 0px 15px 0px 15px;
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
              .active {
                border: 2px solid oklch(0.5873 0.2156 265.65);
                box-shadow: 0 0 10px oklch(0.5873 0.2156 265.65/0.5);
              }
              .locked {
                opacity: 0.5;
                pointer-events: none;
              }
            </style>
          </head>
          <body>
            <nav>
              <div class="nav-item">
                <svg
                  class="w-6 h-6 text-gray-800 dark:text-white"
                  aria-hidden="true"
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-width="2"
                    d="M5 7h14M5 12h14M5 17h14"
                  />
                </svg>
              </div>
              <div class="nav-item">
                <p class="title">Frontend Development</p>
                <svg
                  class="w-6 h-6 text-gray-800 dark:text-white"
                  aria-hidden="true"
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="3"
                    d="m19 9-7 7-7-7"
                  />
                </svg>
              </div>
              <div class="nav-item">
                <img src="https://placehold.co/40x40" alt="" class="profile-picture" />
              </div>
            </nav>

            <div class="module-list">
              <div class="module-card">
                <h3>1. Variables & Scope</h3>
                <p>Progress: 100% - 3/3 objectives</p>
              </div>

              <div class="module-card active">
                <h3>2. DOM Manipulation</h3>
                <p>Progress: 66% - 2/3 objectives</p>
                <p>Learn to dynamically update the UI.</p>
                <button>Continue Lesson</button>
              </div>

              <div class="module-card locked">
                <h3>3. Async/Await</h3>
                <p>Complete previous modules to unlock!</p>
              </div>

              <div class="module-card locked">
                <h3>4. React Fundamentals</h3>
                <p>Complete previous modules to unlock!</p>
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
  }
}

export function deactivate() {}
