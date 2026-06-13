import * as vscode from "vscode";
import WebSocket from "ws";
import { SkillPath } from "../api/client";
import { EventRecorder } from "../telemetry/EventRecorder";
import { SidebarViewProvider } from "../providers/SidebarProvider";
import { CaptureOutcome } from "../commands/captureStruggle";

/** Concept payload mirrored to the sidecar when the user resolves a struggle. */
export interface AutoConceptPayload {
  concept_id: string;
  concept_name?: string;
  misconception?: string;
  hint?: string;
}

const LANE1_FLUSH_MS = 5000;
const WS_PING_MS = 20000;
const WS_RECONNECT_MIN_MS = 2000;
const WS_RECONNECT_MAX_MS = 30000;
const DEFAULT_COMPLETENESS_IDLE_MS = 45000;

/**
 * Owns the lifecycle of a "struggle sidecar" session for the active task.
 *
 * A session ties together four loops, all best-effort and tolerant of the
 * sidecar being down (nothing here is allowed to break the core extension):
 *  - REST session create/end
 *  - a WS command channel (sidecar can ask us to capture the current struggle)
 *  - a Lane-1 flush loop that streams passive EventRecorder events to /v1/ingest
 *  - a completeness debounce that asks the sidecar to grade the current code
 *
 * Sidecar integration is purely additive: it runs ALONGSIDE the existing
 * struggle-capture → main-backend flow, never replacing it.
 */
export class SidecarSessionManager implements vscode.Disposable {
  private sessionId?: string;
  /** skillpath_id of the task the current session belongs to. */
  private sessionTaskId?: string;

  private ws?: WebSocket;
  /** True while a session is active; gates auto-reconnect of the WS channel. */
  private sessionActive = false;
  private reconnectDelay = WS_RECONNECT_MIN_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;

  private flushTimer?: ReturnType<typeof setInterval>;
  /** Max event ts already shipped to the sidecar; only newer events are sent. */
  private lastFlushedTs = 0;

  private completenessTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly provider: SidebarViewProvider,
    private readonly eventRecorder: EventRecorder,
    private readonly captureCallback: () => Promise<CaptureOutcome>,
  ) {
    // Completeness triggers: on save, and after a stretch of editing inactivity.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleCompleteness(0)),
      vscode.workspace.onDidChangeTextDocument(() =>
        this.scheduleCompleteness(this.completenessIdleMs()),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  private config() {
    return vscode.workspace.getConfiguration("antiCopilot");
  }

  private isEnabled(): boolean {
    return this.config().get<boolean>("sidecarEnabled", true);
  }

  private baseUrl(): string {
    return this.config()
      .get<string>("sidecarBaseUrl", "http://127.0.0.1:9100")
      .replace(/\/$/, "");
  }

  private wsBaseUrl(): string {
    return this.baseUrl().replace(/^http(s?):\/\//, (_m, s) => `ws${s}://`);
  }

  private token(): string {
    return this.config().get<string>("sidecarToken", "dev-sidecar-token");
  }

  private completenessIdleMs(): number {
    return this.config().get<number>("sidecarCompletenessIdleMs", DEFAULT_COMPLETENESS_IDLE_MS);
  }

  // ---------------------------------------------------------------------------
  // REST helper (mirrors client.ts error-handling style)
  // ---------------------------------------------------------------------------

  private async restFetch<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T | undefined> {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      };
      const res = await fetch(`${this.baseUrl()}${path}`, { ...init, headers });
      if (!res.ok) {
        const detail = await this.parseError(res);
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      // Some endpoints may return empty bodies; guard the json() parse.
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T | undefined;
    } catch (err) {
      // Fail soft: the sidecar being unreachable must never break the extension.
      console.error(`[sidecar] ${path} failed:`, err);
      return undefined;
    }
  }

  private async parseError(res: Response): Promise<string> {
    try {
      const body = (await res.clone().json()) as { detail?: unknown };
      if (typeof body.detail === "string") {
        return body.detail;
      }
      if (body.detail && typeof body.detail === "object") {
        return JSON.stringify(body.detail);
      }
    } catch {
      // Fall back to plain text below.
    }
    try {
      return await res.text();
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  public async startSessionForTask(task: SkillPath): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    if (!task?.skillpath_id) {
      return;
    }
    // Already running for this exact task — nothing to do.
    if (this.sessionActive && this.sessionTaskId === task.skillpath_id) {
      return;
    }
    // Switched tasks — close the old session before opening a new one.
    if (this.sessionActive) {
      await this.endCurrentSession();
    }

    const result = await this.restFetch<{ session_id: string }>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        task_ref: task.skillpath_id,
        task_meta: { title: task.title },
      }),
    });

    if (!result?.session_id) {
      // Sidecar down or rejected the session — stay dormant, try again on the
      // next task switch. Core extension behavior is unaffected.
      return;
    }

    this.sessionId = result.session_id;
    this.sessionTaskId = task.skillpath_id;
    this.sessionActive = true;
    // Don't dump the whole pre-session shadow buffer on first flush — only
    // stream events that happen from now on.
    this.lastFlushedTs = Date.now();

    this.connectWs();
    this.startFlushLoop();
  }

  /** Whether a live session is currently running (drives the End command's UX). */
  public isSessionActive(): boolean {
    return this.sessionActive;
  }

  /**
   * End the live session only if it belongs to the given task. Used by the
   * completion flow: the live app shows a single task per session, so marking
   * the task complete is the session's natural end — but if the session
   * already moved on to a different task (mid-flight task switch), it must
   * be left alone.
   */
  public async endSessionForTask(skillpathId: string): Promise<void> {
    if (this.sessionActive && this.sessionTaskId === skillpathId) {
      await this.endCurrentSession();
    }
  }

  public async endCurrentSession(): Promise<void> {
    if (!this.sessionActive) {
      return;
    }
    const sessionId = this.sessionId;
    // Flip state first so reconnect/flush loops stop touching this session.
    this.sessionActive = false;
    this.stopFlushLoop();
    this.closeWs();
    if (this.completenessTimer) {
      clearTimeout(this.completenessTimer);
      this.completenessTimer = undefined;
    }
    this.sessionId = undefined;
    this.sessionTaskId = undefined;

    if (sessionId) {
      await this.restFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/end`, {
        method: "POST",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // WS command channel
  // ---------------------------------------------------------------------------

  private connectWs(): void {
    if (!this.sessionActive || !this.sessionId) {
      return;
    }
    const url = `${this.wsBaseUrl()}/v1/extension/${encodeURIComponent(
      this.sessionId,
    )}?token=${encodeURIComponent(this.token())}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error("[sidecar] failed to open WS:", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on("open", () => {
      // Successful connect — reset backoff and start the liveness ping.
      this.reconnectDelay = WS_RECONNECT_MIN_MS;
      this.startPing();
    });

    socket.on("message", (data: WebSocket.RawData) => {
      void this.onWsMessage(data);
    });

    socket.on("close", () => {
      this.stopPing();
      if (this.ws === socket) {
        this.ws = undefined;
      }
      // Reconnect only while the session is still meant to be alive.
      if (this.sessionActive) {
        this.scheduleReconnect();
      }
    });

    socket.on("error", (err) => {
      // 'close' fires after 'error', which is where reconnect is scheduled.
      console.error("[sidecar] WS error:", err);
    });
  }

  private async onWsMessage(data: WebSocket.RawData): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg?.type === "capture_struggle") {
      const requestId = msg.request_id;
      let outcome: CaptureOutcome;
      try {
        outcome = await this.captureCallback();
      } catch (err: any) {
        outcome = { ok: false, reason: err?.message ?? "capture failed" };
      }
      if (outcome.ok) {
        this.sendWs({
          type: "concept_resolved",
          request_id: requestId,
          concept_id: outcome.concept_id,
          concept_name: outcome.concept_name,
          misconception: outcome.misconception,
          hint: outcome.hint,
        });
      } else {
        this.sendWs({
          type: "capture_failed",
          request_id: requestId,
          reason: outcome.reason,
        });
      }
    }
  }

  private sendWs(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        console.error("[sidecar] WS send failed:", err);
      }
    }
  }

  /**
   * Mirror a user-initiated struggle resolution to the sidecar. No request_id —
   * it's tagged source:"auto" so the sidecar knows the user fired this in VS
   * Code rather than being prompted. No-op if the WS isn't open.
   */
  public registerAutoConcept(payload: AutoConceptPayload): void {
    this.sendWs({
      type: "concept_resolved",
      source: "auto",
      concept_id: payload.concept_id,
      concept_name: payload.concept_name,
      misconception: payload.misconception,
      hint: payload.hint,
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendWs({ type: "ping" });
    }, WS_PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (!this.sessionActive || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWs();
    }, delay);
    // Exponential backoff, capped.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, WS_RECONNECT_MAX_MS);
  }

  private closeWs(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectDelay = WS_RECONNECT_MIN_MS;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Lane-1 flush loop
  // ---------------------------------------------------------------------------

  private startFlushLoop(): void {
    this.stopFlushLoop();
    this.flushTimer = setInterval(() => {
      void this.flushEvents();
    }, LANE1_FLUSH_MS);
  }

  private stopFlushLoop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async flushEvents(): Promise<void> {
    if (!this.sessionActive || !this.sessionId) {
      return;
    }
    const events = this.eventRecorder
      .snapshot()
      .filter((e) => e.ts > this.lastFlushedTs);
    if (events.length === 0) {
      return;
    }
    const maxTs = events.reduce((m, e) => Math.max(m, e.ts), this.lastFlushedTs);
    const result = await this.restFetch<{ struggleness?: number; accepted?: boolean }>(
      "/v1/ingest",
      {
        method: "POST",
        body: JSON.stringify({ session_id: this.sessionId, events }),
      },
    );
    // Only advance the watermark once the events were actually shipped, so a
    // failed POST is retried on the next tick rather than silently dropped.
    if (result !== undefined) {
      this.lastFlushedTs = maxTs;
    }
  }

  // ---------------------------------------------------------------------------
  // Completeness debounce
  // ---------------------------------------------------------------------------

  private scheduleCompleteness(delayMs: number): void {
    if (!this.sessionActive) {
      return;
    }
    if (this.completenessTimer) {
      clearTimeout(this.completenessTimer);
    }
    this.completenessTimer = setTimeout(() => {
      this.completenessTimer = undefined;
      void this.estimateCompleteness();
    }, delayMs);
  }

  private async estimateCompleteness(): Promise<void> {
    if (!this.sessionActive || !this.sessionId) {
      return;
    }
    const task = this.provider.getActiveTask();
    const editor = vscode.window.activeTextEditor;
    if (!task || !editor) {
      return;
    }
    await this.restFetch(
      `/v1/sessions/${encodeURIComponent(this.sessionId)}/completeness`,
      {
        method: "POST",
        body: JSON.stringify({
          task_ref: task.skillpath_id,
          task_title: task.title,
          task_description: task.description,
          learning_objectives: task.learning_objectives,
          code: editor.document.getText(),
        }),
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    // Best-effort end of the live session (fire-and-forget; dispose is sync).
    void this.endCurrentSession();
  }
}
