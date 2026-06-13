# AntiCopilot VS Code Extension

The sensor layer for the AntiCopilot adaptive learning system. It captures real-world coding struggles, delivers inline AI hints, and manages your FSRS-powered review queue directly within the editor.

## Features

- **Struggle reporting** — captures code context plus active diagnostics, sends them to the backend, and displays an AI-generated hint in the sidebar.
- **Sidebar panel** — manage active learning tasks, spaced repetition reviews, and on-demand practice tasks.
- **Deep-link integration** — supports `vscode://` URIs to sync state instantly with the web dashboard.

## Project Structure

```
src/
├── extension.ts          # Entry point — activate/deactivate lifecycle only
├── commands/
│   ├── requestHint.ts    # "I'm Stuck — Get a Hint": memory hint + struggle report
│   ├── captureStruggle.ts # Shared struggle-capture core (command + sidecar remote)
│   └── diagnostics.ts    # Highlight diagnostics decoration command
├── providers/
│   └── SidebarProvider.ts # Source of truth for active task; manages Webview state
├── views/
│   └── sidebarHtml.ts    # HTML template for the sidebar Webview
└── api/
    └── client.ts         # Fetch wrappers for the anticopilot-agent backend (port 8000)
```

## Requirements

- VS Code `^1.109.0`
- Node.js
- The agent backend running on `http://localhost:8000` (required at runtime for hints, reviews, and roadmap data)

## How to Run

### Install

```bash
npm install
```

### Development (with watch mode)

```bash
npm install
npm run watch        # Rebuilds on every file save (TypeScript + esbuild)
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Distribute

```bash
npm run package      # Generates .vsix
```

## Extension Settings

> [!NOTE]
> The backend URL is currently hardcoded to http://localhost:8000. No additional configuration is required.