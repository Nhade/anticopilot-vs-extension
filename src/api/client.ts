const BASE_URL = "http://localhost:8000";

export interface ReviewConcept {
  concept_id: string;
  source_type: "struggle_signal" | "skill_path";
  source_ref_id: string;
  concept_metadata: {
    concept_name?: string;
    misconception?: string;
    language?: string;
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
  roadmap: any;
  milestones: any[];
  skillpaths: any[];
}

export async function getDueReviews(): Promise<ReviewConcept[]> {
  const res = await fetch(`${BASE_URL}/v1/reviews/due`);
  if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
  return res.json() as Promise<ReviewConcept[]>;
}

export async function generateTask(conceptId: string): Promise<PracticeTask> {
  const res = await fetch(`${BASE_URL}/v1/reviews/${conceptId}/generate-task`, { method: "POST" });
  if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
  return res.json() as Promise<PracticeTask>;
}

export async function gradeReview(conceptId: string, grade: 1 | 2 | 3 | 4): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/v1/reviews/${conceptId}/grade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade })
  });
  if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
  return res.json();
}

export async function getRoadmap(roadmapId: string): Promise<RoadmapData> {
  const res = await fetch(`${BASE_URL}/v1/roadmaps/${roadmapId}`);
  if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
  return res.json() as Promise<RoadmapData>;
}
