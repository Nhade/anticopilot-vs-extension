import * as vscode from "vscode";
import { createHash } from "crypto";

/**
 * Shadow-mode passive event recorder.
 *
 * Subscribes to a curated set of VS Code editor events and stores compact,
 * metadata-only records in a bounded ring buffer. Code content, raw text,
 * symbol names, and file paths are NEVER recorded — file URIs are hashed
 * to short opaque IDs so the same file is recognizable across events
 * without exposing its location on disk.
 *
 * The buffer is local until something explicitly snapshots it (typically
 * the struggle capture behind the I'm-Stuck hint, or the dump command). It
 * is not transmitted otherwise.
 *
 * The capacity and the per-editor selection-coalesce window are sampling
 * decisions (memory + event-firehose bounds), NOT interpretation thresholds.
 * Nothing in this file decides whether an event "means" the user is stuck.
 */

export type RecordedEventKind =
  | "edit"
  | "diagnostic_change"
  | "selection_change"
  | "editor_switch"
  | "save"
  | "task_end"
  | "debug_start"
  | "debug_end"
  | "terminal_exec_start"
  | "terminal_exec_end"
  | "window_state"
  // Synthetic anchors emitted by the extension (not raw VS Code events) so the
  // timeline records when we intervened — lets analysis see post-hint behavior.
  | "struggle_reported"
  | "hint_shown";

export interface RecordedEvent {
  /** Milliseconds since epoch. */
  ts: number;
  kind: RecordedEventKind;
  /** Short opaque hash of the file URI, when an event is tied to a file. */
  file_hash?: string;
  language_id?: string;
  /** Event-kind-specific metadata. Never contains code content. */
  meta?: Record<string, unknown>;
}

// High-frequency editor churn. Kept in its own bounded lane so a burst of
// typing/cursor-movement can't evict the rarer, higher-value events (focus
// changes, diagnostic transitions, terminal runs) from before it. A real
// 17.6-min session was 76% these two kinds and overflowed a single 1000 ring,
// truncating the buffer to its last ~17 min.
const NOISY_KINDS = new Set<RecordedEventKind>(["edit", "selection_change"]);

// These are capacity / memory bounds (sampling decisions), NOT interpretation
// thresholds — nothing here decides whether the user is "stuck". The signal
// lane is sized to span hours of a normal session; the noisy lane caps the
// firehose while still preserving recent typing rhythm and undo bursts.
const DEFAULT_NOISY_CAPACITY = 600;
const DEFAULT_SIGNAL_CAPACITY = 1500;
const DEFAULT_SELECTION_COALESCE_MS = 500;

export interface EventRecorderOptions {
  noisyCapacity?: number;
  signalCapacity?: number;
  selectionCoalesceMs?: number;
}

function hashUri(uri: vscode.Uri): string {
  return createHash("sha256").update(uri.toString()).digest("hex").slice(0, 12);
}

/** Short opaque digest of an arbitrary string. Used for identity, never to be reversed. */
function hashShort(value: string, len = 10): string {
  return createHash("sha256").update(value).digest("hex").slice(0, len);
}

/** Normalize a diagnostic code (string | number | {value}) to a stable string. */
function codeToString(code: vscode.Diagnostic["code"]): string {
  if (code === undefined || code === null) {
    return "";
  }
  if (typeof code === "object") {
    return String(code.value);
  }
  return String(code);
}

/**
 * Compute a per-diagnostic fingerprint set for a file. Each fingerprint hashes
 * (line + code + source + severity) — never the message text — so we can detect
 * the SAME diagnostic persisting across edits (a stuck-on-one-fix signal) or
 * a set thrashing in and out, without storing anything human-readable.
 * Returned sorted so the joined form is a stable change-detection signature.
 */
function diagnosticFingerprints(diagnostics: readonly vscode.Diagnostic[]): string[] {
  const fps = diagnostics.map((d) =>
    hashShort(`${d.range.start.line}:${codeToString(d.code)}:${d.source ?? ""}:${d.severity}`)
  );
  fps.sort();
  return fps;
}

/**
 * Extract a low-sensitivity command label: the leading token's basename, kept
 * only if it's a plain identifier (e.g. "npm", "python", "git"). Anything with
 * a path, quote, or odd character is dropped rather than risk leaking a path or
 * secret. The full command is never stored — only its hash (for repeat
 * detection) and, when safe, this coarse tool name.
 */
function safeCommandHead(commandLine: string): string | undefined {
  const firstToken = commandLine.trim().split(/\s+/)[0] ?? "";
  const base = firstToken.split(/[\\/]/).pop() ?? "";
  return /^[A-Za-z0-9_.-]{1,24}$/.test(base) ? base : undefined;
}

function severityCounts(diagnostics: readonly vscode.Diagnostic[]): Record<string, number> {
  const counts: Record<string, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of diagnostics) {
    switch (d.severity) {
      case vscode.DiagnosticSeverity.Error: counts.error++; break;
      case vscode.DiagnosticSeverity.Warning: counts.warning++; break;
      case vscode.DiagnosticSeverity.Information: counts.info++; break;
      case vscode.DiagnosticSeverity.Hint: counts.hint++; break;
    }
  }
  return counts;
}

export class EventRecorder implements vscode.Disposable {
  private readonly noisyCapacity: number;
  private readonly signalCapacity: number;
  private readonly selectionCoalesceMs: number;
  /** High-frequency editor churn (edit, selection_change). */
  private readonly noisyBuffer: RecordedEvent[] = [];
  /** Rarer, higher-value events (focus, diagnostics, terminal, anchors, …). */
  private readonly signalBuffer: RecordedEvent[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  /** Tracks last selection-event time per editor (by file hash) for coalescing. */
  private readonly lastSelectionTs = new Map<string, number>();
  /** Tracks last diagnostic signature per file, to collapse redundant re-emits. */
  private readonly lastDiagSignature = new Map<string, string>();

  constructor(options: EventRecorderOptions = {}) {
    this.noisyCapacity = options.noisyCapacity ?? DEFAULT_NOISY_CAPACITY;
    this.signalCapacity = options.signalCapacity ?? DEFAULT_SIGNAL_CAPACITY;
    this.selectionCoalesceMs = options.selectionCoalesceMs ?? DEFAULT_SELECTION_COALESCE_MS;

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onTextChange(e)),
      vscode.languages.onDidChangeDiagnostics((e) => this.onDiagnostics(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeActiveTextEditor((e) => this.onEditorSwitch(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
      vscode.tasks.onDidEndTaskProcess((e) => this.onTaskEnd(e)),
      vscode.debug.onDidStartDebugSession((s) => this.onDebugStart(s)),
      vscode.debug.onDidTerminateDebugSession((s) => this.onDebugEnd(s)),
      vscode.window.onDidStartTerminalShellExecution((e) => this.onTerminalStart(e)),
      vscode.window.onDidEndTerminalShellExecution((e) => this.onTerminalEnd(e)),
      vscode.window.onDidChangeWindowState((s) => this.onWindowState(s)),
    );
  }

  private push(event: RecordedEvent): void {
    const isNoisy = NOISY_KINDS.has(event.kind);
    const buffer = isNoisy ? this.noisyBuffer : this.signalBuffer;
    const cap = isNoisy ? this.noisyCapacity : this.signalCapacity;
    buffer.push(event);
    if (buffer.length > cap) {
      buffer.splice(0, buffer.length - cap);
    }
  }

  /**
   * Record a synthetic anchor event from the extension (e.g. a struggle was
   * reported, a hint was shown). Routed to the signal lane so it survives
   * heavy typing and lets us reason about behavior around the intervention.
   */
  public mark(
    kind: Extract<RecordedEventKind, "struggle_reported" | "hint_shown">,
    meta?: Record<string, unknown>,
  ): void {
    this.push({ ts: Date.now(), kind, meta });
  }

  private onTextChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) {
      return;
    }
    let inserted = 0;
    let deleted = 0;
    for (const c of e.contentChanges) {
      inserted += c.text.length;
      deleted += c.rangeLength;
    }
    this.push({
      ts: Date.now(),
      kind: "edit",
      file_hash: hashUri(e.document.uri),
      language_id: e.document.languageId,
      meta: {
        change_count: e.contentChanges.length,
        inserted_chars: inserted,
        deleted_chars: deleted,
        reason: e.reason === vscode.TextDocumentChangeReason.Undo ? "undo"
              : e.reason === vscode.TextDocumentChangeReason.Redo ? "redo"
              : "edit",
      },
    });
  }

  private onDiagnostics(e: vscode.DiagnosticChangeEvent): void {
    for (const uri of e.uris) {
      const fileHash = hashUri(uri);
      const diagnostics = vscode.languages.getDiagnostics(uri);
      const fingerprints = diagnosticFingerprints(diagnostics);
      const signature = fingerprints.join(",");

      // Collapse flicker: VS Code re-emits diagnostics on nearly every keystroke
      // with an identical set. Only record genuine transitions (a diagnostic
      // appeared, cleared, or the set changed). In a measured Next.js session,
      // 93% of diagnostic_change events were redundant re-emits; collapsing on
      // identity preserves set-changes even when the count is unchanged.
      if (this.lastDiagSignature.get(fileHash) === signature) {
        continue;
      }
      this.lastDiagSignature.set(fileHash, signature);

      this.push({
        ts: Date.now(),
        kind: "diagnostic_change",
        file_hash: fileHash,
        meta: {
          total: diagnostics.length,
          by_severity: severityCounts(diagnostics),
          // Opaque per-diagnostic identities (line+code+source+severity hashes).
          // Enables "same error persisting across edits" analysis. No message text.
          fingerprints,
        },
      });
    }
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const fileHash = hashUri(e.textEditor.document.uri);
    const now = Date.now();
    const last = this.lastSelectionTs.get(fileHash) ?? 0;
    if (now - last < this.selectionCoalesceMs) {
      return;
    }
    this.lastSelectionTs.set(fileHash, now);
    const sel = e.selections[0];
    this.push({
      ts: now,
      kind: "selection_change",
      file_hash: fileHash,
      language_id: e.textEditor.document.languageId,
      meta: {
        kind: e.kind === vscode.TextEditorSelectionChangeKind.Keyboard ? "keyboard"
            : e.kind === vscode.TextEditorSelectionChangeKind.Mouse ? "mouse"
            : e.kind === vscode.TextEditorSelectionChangeKind.Command ? "command"
            : "unknown",
        line: sel?.active.line,
        has_selection: sel ? !sel.isEmpty : false,
      },
    });
  }

  private onEditorSwitch(editor: vscode.TextEditor | undefined): void {
    this.push({
      ts: Date.now(),
      kind: "editor_switch",
      file_hash: editor ? hashUri(editor.document.uri) : undefined,
      language_id: editor?.document.languageId,
    });
  }

  private onSave(doc: vscode.TextDocument): void {
    this.push({
      ts: Date.now(),
      kind: "save",
      file_hash: hashUri(doc.uri),
      language_id: doc.languageId,
    });
  }

  private onTaskEnd(e: vscode.TaskProcessEndEvent): void {
    this.push({
      ts: Date.now(),
      kind: "task_end",
      meta: {
        exit_code: e.exitCode,
        task_type: e.execution.task.definition.type,
        task_source: e.execution.task.source,
      },
    });
  }

  private onDebugStart(s: vscode.DebugSession): void {
    this.push({
      ts: Date.now(),
      kind: "debug_start",
      meta: { session_type: s.type },
    });
  }

  private onDebugEnd(s: vscode.DebugSession): void {
    this.push({
      ts: Date.now(),
      kind: "debug_end",
      meta: { session_type: s.type },
    });
  }

  private onTerminalStart(e: vscode.TerminalShellExecutionStartEvent): void {
    const cmd = e.execution.commandLine.value;
    this.push({
      ts: Date.now(),
      kind: "terminal_exec_start",
      meta: {
        // Hash lets us detect the SAME command re-run repeatedly (e.g. a test
        // failing over and over) without storing the command text. The coarse
        // head (npm/python/git) is kept only when it's a safe identifier.
        command_hash: hashShort(cmd),
        command_head: safeCommandHead(cmd),
      },
    });
  }

  private onTerminalEnd(e: vscode.TerminalShellExecutionEndEvent): void {
    const cmd = e.execution.commandLine.value;
    this.push({
      ts: Date.now(),
      kind: "terminal_exec_end",
      meta: {
        command_hash: hashShort(cmd),
        command_head: safeCommandHead(cmd),
        // undefined exit code (ctrl+c, sub-shell, no shell-integration report)
        // is recorded as-is; analysis can treat it as a non-success per the API note.
        exit_code: e.exitCode,
      },
    });
  }

  private onWindowState(state: vscode.WindowState): void {
    // focused = VS Code is the foreground window; active = interacted with
    // recently (VS Code flips this after a short inactivity it defines itself,
    // so we get an idle bit without inventing our own threshold). Together these
    // disambiguate long event-gaps: thinking-in-editor vs. reading-in-browser
    // vs. away-from-keyboard.
    this.push({
      ts: Date.now(),
      kind: "window_state",
      meta: { focused: state.focused, active: state.active },
    });
  }

  /**
   * Returns both lanes merged into a single chronological stream.
   * Order: oldest → newest (stable: signal events before noisy at equal ts,
   * so an anchor lands before same-millisecond keystrokes).
   */
  public snapshot(): RecordedEvent[] {
    return [...this.signalBuffer, ...this.noisyBuffer].sort((a, b) => a.ts - b.ts);
  }

  public size(): number {
    return this.signalBuffer.length + this.noisyBuffer.length;
  }

  public clear(): void {
    this.noisyBuffer.length = 0;
    this.signalBuffer.length = 0;
    this.lastSelectionTs.clear();
    this.lastDiagSignature.clear();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.clear();
  }
}
