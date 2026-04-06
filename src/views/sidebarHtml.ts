import * as vscode from 'vscode';

export function getSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.css'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>

  <!-- Tab bar -->
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="task">Task</button>
    <button class="tab-btn" data-tab="reviews">Reviews</button>
    <button class="tab-btn" data-tab="roadmap">Roadmap</button>
  </div>

  <!-- Task Panel -->
  <div id="panel-task" class="panel active"></div>

  <!-- Reviews Panel -->
  <div id="panel-reviews" class="panel"></div>

  <!-- Roadmap Panel -->
  <div id="panel-roadmap" class="panel"></div>

  <!-- Hint Notification -->
  <div id="hint-notif" class="hint-notif">
    <button class="hint-close" onclick="closeHint()">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
    <div class="hint-notif-header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      AntiCopilot Hint
    </div>
    <div id="hint-body" class="hint-notif-body"></div>
    <div id="hint-footer" class="hint-notif-footer" style="display:none"></div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}
