import type { ThresholdConfig } from "../domain/config";
import type { Vote } from "../domain/models";
import type { VoteAggregation, ThresholdEvaluation } from "./types";

export function aggregateVotes(votes: Vote[]): Omit<VoteAggregation, "meeting_id" | "vote_session_id" | "stage_version"> & { votes: Vote[] } {
  if (votes.length === 0) {
    return { votes, avg_score: 0, min_score: 0, max_score: 0 };
  }
  const scores = votes.map((v) => v.score);
  const sum = scores.reduce((a, b) => a + b, 0);
  return {
    votes,
    avg_score: Math.round(sum / scores.length),
    min_score: Math.min(...scores),
    max_score: Math.max(...scores),
  };
}

export function evaluateThreshold(input: {
  threshold: ThresholdConfig;
  round: number;
  aggregation: VoteAggregation;
}): ThresholdEvaluation {
  const { threshold, round, aggregation } = input;

  if (round < threshold.min_rounds) {
    return {
      accepted: false,
      reason: `Minimum rounds not reached (${round}/${threshold.min_rounds})`,
      avg_score: aggregation.avg_score,
      required_threshold: threshold.avg_score_threshold,
    };
  }

  if (threshold.mode === "avg_score") {
    const accepted = aggregation.avg_score >= threshold.avg_score_threshold;
    return {
      accepted,
      reason: accepted
        ? `Average score ${aggregation.avg_score} meets threshold ${threshold.avg_score_threshold}`
        : `Average score ${aggregation.avg_score} below threshold ${threshold.avg_score_threshold}`,
      avg_score: aggregation.avg_score,
      required_threshold: threshold.avg_score_threshold,
    };
  }

  return {
    accepted: false,
    reason: `Unknown threshold mode: ${threshold.mode}`,
    avg_score: aggregation.avg_score,
    required_threshold: threshold.avg_score_threshold,
  };
}
