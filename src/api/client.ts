import * as vscode from "vscode";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_USER_ID = "default-user";

function apiBaseUrl(): string {
  return vscode.workspace
    .getConfiguration("antiCopilot")
    .get<string>("apiBaseUrl", DEFAULT_BASE_URL)
    .replace(/\/$/, "");
}

export function apiUserId(): string {
  return vscode.workspace
    .getConfiguration("antiCopilot")
    .get<string>("userId", DEFAULT_USER_ID);
}

export function apiToken(): string {
  return vscode.workspace
    .getConfiguration("antiCopilot")
    .get<string>("apiToken", "");
}

function withUserId(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${apiBaseUrl()}${path}${separator}user_id=${encodeURIComponent(apiUserId())}`;
}

// Send the shared bearer token only when one is configured, so local dev
// against an auth-less backend keeps working unchanged.
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = apiToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { detail?: unknown };
    if (typeof body.detail === "string") {
      return body.detail;
    }
    if (body.detail && typeof body.detail === "object") {
      return JSON.stringify(body.detail);
    }
  } catch {
    // Fall back to plain text below.
  }
  return await res.text();
}

async function expectOk(res: Response): Promise<void> {
  if (!res.ok) {
    const detail = await parseError(res);
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

export type LearningContentType = "article" | "coding_problem" | "multiple_choice";
export type PracticeMode = "coding_problem" | "multiple_choice" | "either";
export type CodingProblemDifficulty = "easy" | "medium" | "hard";

export interface SourceLink {
  title: string;
  url: string;
}

export interface ContentSourceNote {
  source: SourceLink;
  note: string;
}

export interface MultipleChoiceOption {
  option_id: string;
  text: string;
}

interface BaseLearningContent {
  content_id: string;
  skillpath_id: string;
  title: string;
  description: string;
}

export interface ArticleLearningContent extends BaseLearningContent {
  content_type: "article";
  skill_intro: string;
  reading_content: string;
  references?: SourceLink[];
  source_notes?: ContentSourceNote[];
}

export interface CodingProblemLearningContent extends BaseLearningContent {
  content_type: "coding_problem";
  prompt: string;
  difficulty: CodingProblemDifficulty;
  starter_code?: string | null;
  expected_output?: string | null;
  hints?: string[];
}

export interface MultipleChoiceLearningContent extends BaseLearningContent {
  content_type: "multiple_choice";
  question: string;
  options: MultipleChoiceOption[];
  correct_option_id: string;
  explanation: string;
}

export type LearningContentItem =
  | ArticleLearningContent
  | CodingProblemLearningContent
  | MultipleChoiceLearningContent;

export interface SkillPath {
  roadmap_id?: string;
  skillpath_id: string;
  milestone_id: string;
  title: string;
  description: string;
  estimated_hours: number;
  prerequisite_skillpath_ids?: string[];
  learning_objectives?: string[];
  status?: string;
  need_generation?: boolean;
  practice_mode?: PracticeMode | null;
  learning_contents?: LearningContentItem[];
}

export interface MilestoneWithSkillPaths {
  milestone_id: string;
  roadmap_id: string;
  title: string;
  description: string;
  objective: string;
  estimated_hours: number;
  order_index: number;
  dependency_titles?: string[];
  prerequisite_milestone_ids?: string[];
  status?: string;
  need_modification?: boolean;
  skillpaths?: SkillPath[];
}

export interface ReviewConcept {
  concept_id: string;
  user_id?: string;
  source_type: "struggle_signal" | "skill_path";
  source_ref_id: string;
  concept_metadata: {
    // struggle_signal metadata
    concept_name?: string;
    misconception?: string;
    language?: string;
    concept?: string;
    // skill_path metadata
    skillpath_id?: string;
    content_type?: LearningContentType;
    title?: string;
    description?: string;
    [key: string]: any;
  };
  state: number;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  /** 0..1 memory strength — present on newer backends (practice redesign). */
  retrievability?: number | null;
  /** Projected next interval per grade, in fractional days. */
  interval_previews?: { again: number; hard: number; good: number; easy: number } | null;
}

export interface PracticeTask {
  task_type: string;
  content: string;
  solution: string;
}

export interface RoadmapData {
  roadmap_id: string;
  title?: string;
  version: number;
  summary: string;
  target_outcome: string;
  assumptions: string[];
  milestones: MilestoneWithSkillPaths[];
}

export interface RecordedEventPayload {
  ts: number;
  kind: string;
  file_hash?: string;
  language_id?: string;
  meta?: Record<string, unknown>;
}

export interface StruggleSignalPayload {
  roadmap_id: string;
  milestone_id: string;
  skillpath_id: string;
  code_context: string;
  diagnostic_message: string;
  language: string;
  pre_event_window?: RecordedEventPayload[];
}

export interface StruggleSignalResponse {
  hint: string;
  concept_name?: string;
  concept_id?: string;
  misconception?: string;
  action_required?: boolean;
}

export interface GenerateContentResponse {
  roadmap_id: string;
  generated_skillpath_count: number;
  roadmap: RoadmapData;
}

export function flattenSkillpaths(roadmap: RoadmapData): SkillPath[] {
  return (roadmap.milestones || []).flatMap((milestone) =>
    (milestone.skillpaths || []).map((skillpath) => ({
      ...skillpath,
      roadmap_id: skillpath.roadmap_id || roadmap.roadmap_id,
      milestone_id: skillpath.milestone_id || milestone.milestone_id,
    }))
  );
}

export async function getDueReviews(): Promise<ReviewConcept[]> {
  const res = await fetch(withUserId("/v1/reviews/due"), { headers: authHeaders() });
  await expectOk(res);
  return res.json() as Promise<ReviewConcept[]>;
}

export async function generateTask(conceptId: string): Promise<PracticeTask> {
  const res = await fetch(withUserId(`/v1/reviews/${encodeURIComponent(conceptId)}/generate-task`), { method: "POST", headers: authHeaders() });
  await expectOk(res);
  return res.json() as Promise<PracticeTask>;
}

export async function gradeReview(conceptId: string, grade: 1 | 2 | 3 | 4): Promise<unknown> {
  const res = await fetch(withUserId(`/v1/reviews/${encodeURIComponent(conceptId)}/grade`), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ grade })
  });
  await expectOk(res);
  return res.json();
}

export async function getRoadmap(roadmapId: string): Promise<RoadmapData> {
  const res = await fetch(withUserId(`/v1/roadmaps/${encodeURIComponent(roadmapId)}`), { headers: authHeaders() });
  await expectOk(res);
  return res.json() as Promise<RoadmapData>;
}

export async function generateSkillpathContent(
  roadmapId: string,
  skillpathId: string,
  options: { force?: boolean } = {}
): Promise<GenerateContentResponse> {
  const params = new URLSearchParams();
  if (options.force) {
    params.set("force", "true");
  }
  const query = params.toString();
  const path = `/v1/roadmaps/${encodeURIComponent(roadmapId)}/skillpaths/${encodeURIComponent(skillpathId)}/generate-content${query ? `?${query}` : ""}`;
  const res = await fetch(withUserId(path), { method: "POST", headers: authHeaders() });
  await expectOk(res);
  return res.json() as Promise<GenerateContentResponse>;
}

export async function reportStruggle(
  payload: StruggleSignalPayload
): Promise<StruggleSignalResponse> {
  const res = await fetch(`${apiBaseUrl()}/v1/signals/struggle`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ...payload, user_id: apiUserId() })
  });
  await expectOk(res);
  return res.json() as Promise<StruggleSignalResponse>;
}

export type HintLevel = "nudge" | "conceptual" | "specific" | "near_solution";

export interface MemoryHintPayload {
  skillpath_id?: string;
  content_id?: string;
  task_prompt: string;
  submitted_code?: string;
  language?: string;
  concept_keys?: string[];
  validation_feedback?: string;
  hint_level?: HintLevel;
}

export interface SelectedMemoryMetadata {
  memory_id: string;
  memory_type: string;
  title: string;
  reason?: string;
}

export interface MemoryHintResponse {
  hint: string;
  hint_level: HintLevel;
  teaching_action: string;
  selected_memory_ids: string[];
  selected_memories: SelectedMemoryMetadata[];
  focused_concepts: string[];
  quick_recap?: string | null;
  contrast_example?: string | null;
  used_memory: boolean;
}

// Memory-aware hint for the active practice task. Unlike reportStruggle this
// does not create a review concept — it retrieves learner memory (past
// attempts, error patterns) and returns a low-spoiler hint scoped to the
// coding problem the learner is working on.
export async function requestMemoryHint(
  payload: MemoryHintPayload
): Promise<MemoryHintResponse> {
  const res = await fetch(`${apiBaseUrl()}/v1/hints`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ...payload, user_id: apiUserId() })
  });
  await expectOk(res);
  return res.json() as Promise<MemoryHintResponse>;
}

export type AttemptCorrectness = "correct" | "partially_correct" | "incorrect" | "runtime_error";

export interface TestCaseResult {
  name: string;
  passed: boolean;
  message?: string | null;
}

// Body for POST /v1/code-attempts (backend CodeValidationRequest, minus the
// injected user_id). Diagnostics go in compile_error — the validator weighs
// caller-supplied evidence higher than pure static reasoning.
export interface CodeSubmissionPayload {
  skillpath_id: string;
  content_id: string;
  language: string;
  coding_problem_prompt: string;
  submitted_code: string;
  starter_code?: string | null;
  expected_output?: string | null;
  compile_error?: string | null;
}

export interface CodeValidationVerdict {
  correctness: AttemptCorrectness;
  has_serious_blocker: boolean;
  blocker_reason?: string | null;
  compile_error?: string | null;
  runtime_error?: string | null;
  test_results: TestCaseResult[];
  validation_strategy?: string;
  feedback_summary: string;
  detected_concepts: string[];
  detected_mistakes: string[];
  confidence_score?: number;
}

// The backend's correction half also carries retrieval_context /
// persistence_result / memory_rerank — heavy payloads (notes duplicated with
// 3072-dim embeddings) the extension never consumes; submitCodeAttempt strips
// them before the result crosses into the webview.
export interface CodeCorrectionOutcome {
  inferred_correctness: AttemptCorrectness;
  feedback_summary: string;
  suggested_focus: string[];
}

export interface CodeSubmissionResult {
  validation: CodeValidationVerdict;
  correction: CodeCorrectionOutcome;
}

// Full submission pipeline: deep-agent validation, attempt persistence, and
// learner-memory consolidation. Slow (validator agent + embeddings, often
// 10-30s) — callers must show progress and guard against double submits.
export async function submitCodeAttempt(
  payload: CodeSubmissionPayload
): Promise<CodeSubmissionResult> {
  const res = await fetch(`${apiBaseUrl()}/v1/code-attempts`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ...payload, user_id: apiUserId() })
  });
  await expectOk(res);
  const data = (await res.json()) as {
    validation: CodeValidationVerdict;
    correction?: Partial<CodeCorrectionOutcome>;
  };
  return {
    validation: data.validation,
    correction: {
      inferred_correctness: data.correction?.inferred_correctness ?? data.validation?.correctness ?? "incorrect",
      feedback_summary: data.correction?.feedback_summary ?? "",
      suggested_focus: data.correction?.suggested_focus ?? []
    }
  };
}

// Idempotent lifecycle-status write; returns the refreshed roadmap so callers
// can sync with the same merge pattern as generate-content.
export async function updateSkillpathStatus(
  roadmapId: string,
  skillpathId: string,
  status: string
): Promise<RoadmapData> {
  const path = `/v1/roadmaps/${encodeURIComponent(roadmapId)}/skillpaths/${encodeURIComponent(skillpathId)}/status`;
  const res = await fetch(withUserId(path), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ status })
  });
  await expectOk(res);
  return res.json() as Promise<RoadmapData>;
}
