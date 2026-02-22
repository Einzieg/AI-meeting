import { z } from "zod";
import type { AgentId } from "../domain/ids";
import type { ThresholdConfig } from "../domain/config";
import type { Vote } from "../domain/models";

// ── Vote Session ──

export const VoteSessionStatusSchema = z.enum([
  "RUNNING",
  "FINALIZED",
  "ABORTED",
  "INCOMPLETE",
]);
export type VoteSessionStatus = z.infer<typeof VoteSessionStatusSchema>;

export const VoteSessionSchema = z.object({
  id: z.string().min(1),
  meeting_id: z.string().min(1),
  round: z.number().int().min(0),
  stage_version: z.number().int().min(0),
  proposal_text: z.string().min(1).max(20_000),
  status: VoteSessionStatusSchema,
  started_at: z.string().min(1),
  ended_at: z.string().min(1).nullable().default(null),
  expected_voter_agent_ids: z.array(z.string().min(1)).min(1),
});
export type VoteSession = z.output<typeof VoteSessionSchema>;

// ── Vote Aggregation ──

export type VoteAggregation = {
  meeting_id: string;
  vote_session_id: string;
  stage_version: number;
  votes: Vote[];
  avg_score: number;
  min_score: number;
  max_score: number;
};

// ── Threshold Evaluation ──

export type ThresholdEvaluation = {
  accepted: boolean;
  reason: string;
  avg_score: number;
  required_threshold: number;
};

export type VoteSessionOutcome = {
  meeting_id: string;
  vote_session_id: string;
  stage_version: number;
  status: "FINALIZED" | "ABORTED" | "INCOMPLETE";
  evaluation?: ThresholdEvaluation;
};

// ── Threshold Evaluator ──

export type ThresholdEvaluator = {
  evaluate(input: {
    threshold: ThresholdConfig;
    round: number;
    aggregation: VoteAggregation;
  }): ThresholdEvaluation;
};
