import * as vscode from 'vscode';

export function getSidebarHtml(webview: vscode.Webview) {
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

          /* New styles for Struggle Hint Notification */
          .hint-notification {
            position: fixed;
            bottom: -200px;
            left: 16px;
            right: 16px;
            background: rgba(30, 41, 59, 0.95);
            border: 1px solid rgba(125, 211, 252, 0.3);
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
            border-radius: 12px;
            padding: 16px;
            backdrop-filter: blur(12px);
            transition: bottom 0.5s cubic-bezier(0.16, 1, 0.3, 1);
            z-index: 100;
          }
          
          .hint-notification.show {
            bottom: 16px;
          }
          
          .hint-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            color: var(--active-color);
            font-weight: 600;
            font-size: 13px;
          }
          
          .hint-content {
            font-size: 13px;
            line-height: 1.5;
            color: rgba(255, 255, 255, 0.9);
            max-height: 150px;
            overflow-y: auto;
          }
          
          .hint-close {
            position: absolute;
            top: 12px;
            right: 12px;
            cursor: pointer;
            opacity: 0.5;
            transition: opacity 0.2s;
          }
          
          .hint-close:hover {
            opacity: 1;
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

        <!-- Hint Notification Container -->
        <div id="hint-notification" class="hint-notification">
          <div class="hint-close" onclick="closeHint()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </div>
          <div class="hint-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            AntiCopilot Hint
          </div>
          <div id="hint-content" class="hint-content">
            <!-- Hint content inserted here -->
          </div>
        </div>

        <script>
          const app = document.getElementById('app');
          const hintNotif = document.getElementById('hint-notification');
          const hintContent = document.getElementById('hint-content');
          
          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
              case 'updateTask':
                renderTask(message.task);
                break;
              case 'showHint':
                showHint(message.hint);
                break;
            }
          });

          function showHint(text) {
             hintContent.innerHTML = text.replace(/\\n/g, '<br>');
             hintNotif.classList.add('show');
          }
          
          function closeHint() {
             hintNotif.classList.remove('show');
          }

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
