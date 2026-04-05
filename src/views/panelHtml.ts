export function getDiagnosticsWebviewContent() {
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
