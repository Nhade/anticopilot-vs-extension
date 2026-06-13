import * as vscode from 'vscode';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.css'));
  const nonce = getNonce();

  // CSP: scripts only via the nonce'd tag (no inline handlers anywhere —
  // sidebar.js uses data-action delegation); 'unsafe-inline' styles are
  // needed for dynamic widths (strength bars) and display toggles.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>

  <!-- Tab bar -->
  <div class="tab-bar" role="tablist">
    <button class="tab-btn active" data-tab="task" role="tab" aria-selected="true">Task</button>
    <button class="tab-btn" data-tab="reviews" role="tab" aria-selected="false">Reviews</button>
    <button class="tab-btn" data-tab="roadmap" role="tab" aria-selected="false">Roadmap</button>
  </div>

  <!-- Shown via CSS media query when the sidebar is too narrow -->
  <div class="narrow-notice" role="note">
    <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8 4 12l4 4M16 8l4 4-4 4M4 12h16"/></svg>
    Drag the sidebar edge to widen this view
  </div>

  <!-- Task Panel -->
  <div id="panel-task" class="panel active"></div>

  <!-- Reviews Panel -->
  <div id="panel-reviews" class="panel"></div>

  <!-- Roadmap Panel -->
  <div id="panel-roadmap" class="panel"></div>

  <!-- Hint Notification (inert while hidden offscreen, so its close button
       never traps keyboard focus; sidebar.js toggles inert with .show) -->
  <div id="hint-notif" class="hint-notif" role="alert" inert>
    <button class="hint-close" aria-label="Dismiss hint" data-action="close-hint">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
    <div class="hint-notif-header">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18h6M10 22h4M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>
      </svg>
      AntiCopilot Hint
    </div>
    <div id="hint-body" class="hint-notif-body"></div>
    <div id="hint-footer" class="hint-notif-footer" style="display:none"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
