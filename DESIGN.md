# AntiCopilot VS Code Extension: Design & Conventions

This extension acts as the "sensor layer" for the AntiCopilot learning ecosystem, observing real-world coding behavior to fuel the Spaced Repetition (FSRS) backend. To prevent the extension codebase from devolving into a tangled monolith, all developers must adhere to the following directory structure and design principles.

## Directory Structure

Strictly separate concerns into the following organized directories within \`src/\`:

- \`src/extension.ts\`: The absolute entry point. Only handles the \`activate()\`/\`deactivate()\` lifecycle, loads providers, registers commands, and pushes disposables to the context. **Do not put business logic here.**
- \`src/commands/\`: All command palette actions (e.g., \`requestHint.ts\`). Each file should generally export a single \`registerXCommand()\` function returning a \`vscode.Disposable\`.
- \`src/providers/\`: All Webview View Providers, Tree Data Providers, and state-holding singletons (e.g., \`SidebarProvider.ts\`).
- \`src/views/\`: Static HTML layout templates, CSS, and WebView-specific scripts. Files here should export functions that return HTML strings or URI endpoints.
- \`src/api/\`: Optional. Wrappers for fetch calls to the \`anticopilot-agent\` Python backend.

## Architectural Principles

### 1. Minimal IDE Telemetry
We do **not** want to send every keystroke or raw AST tree to the backend, as this bloats network traffic and threatens privacy.
- Command-driven triggers (like the struggle capture behind \`anti-copilot.requestHint\`) should only scrape the bare minimum context needed (e.g., ±10 lines of code around the active selection).
- Diagnostic scraping should be filtered to only include errors/warnings that intersect with the user's active context.

### 2. State & Sidebar Synchronization
- The \`SidebarProvider\` is the source of truth for the user's "Active Task".
- When deep-linked from the frontend via the \`vscode://.../open-task\` URI handler, the \`SidebarProvider\` must update its internal state (\`roadmap_id\`, \`skillpath_id\`) and post a message to its Webview to re-render.
- Commands (like \`requestHint\`) must query the \`SidebarProvider\` to attach the correct IDs to their API payloads.

### 3. WebView HTML & Scripts
- VS Code Webviews operate in isolated iframes. 
- Avoid directly manipulating the DOM from \`extension.ts\`. 
- The extension should communicate with the Webview strictly via \`webview.postMessage({ command: 'updateView', data: {...} })\`.
- The Webview must handle the incoming data via a \`window.addEventListener('message', ...)\` block and update its own internal HTML.
- **Never inline massive HTML templates inside core logic files.** Isolate them into \`src/views/\`.

## The Struggle Signal Pipeline

The core metric of this extension is the Struggle/Success signal.
1. The user triggers the command manually (Level 1 MVP).
2. The command extracts local context + local diagnostics.
3. The command sends the payload to \`POST /v1/signals/struggle\`.
4. The extension waits for the Tutor hint response.
5. The extension instructs the \`SidebarProvider\` to render the hint via a Webview notification block.
