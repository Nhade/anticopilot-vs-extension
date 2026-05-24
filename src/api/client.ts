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

function withUserId(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${apiBaseUrl()}${path}${separator}user_id=${encodeURIComponent(apiUserId())}`;
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

export interface StruggleSignalPayload {
  roadmap_id: string;
  milestone_id: string;
  skillpath_id: string;
  code_context: string;
  diagnostic_message: string;
  language: string;
}

export interface StruggleSignalResponse {
  hint: string;
  concept_name?: string;
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
  const res = await fetch(withUserId("/v1/reviews/due"));
  await expectOk(res);
  return res.json() as Promise<ReviewConcept[]>;
}

export async function generateTask(conceptId: string): Promise<PracticeTask> {
  const res = await fetch(withUserId(`/v1/reviews/${encodeURIComponent(conceptId)}/generate-task`), { method: "POST" });
  await expectOk(res);
  return res.json() as Promise<PracticeTask>;
}

export async function gradeReview(conceptId: string, grade: 1 | 2 | 3 | 4): Promise<unknown> {
  const res = await fetch(withUserId(`/v1/reviews/${encodeURIComponent(conceptId)}/grade`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade })
  });
  await expectOk(res);
  return res.json();
}

export async function getRoadmap(roadmapId: string): Promise<RoadmapData> {
  const res = await fetch(withUserId(`/v1/roadmaps/${encodeURIComponent(roadmapId)}`));
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
  const res = await fetch(withUserId(path), { method: "POST" });
  await expectOk(res);
  return res.json() as Promise<GenerateContentResponse>;
}

export async function reportStruggle(
  payload: StruggleSignalPayload
): Promise<StruggleSignalResponse> {
  const res = await fetch(`${apiBaseUrl()}/v1/signals/struggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, user_id: apiUserId() })
  });
  await expectOk(res);
  return res.json() as Promise<StruggleSignalResponse>;
}
