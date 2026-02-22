import type { MeetingState } from "../domain/models";

export type EffectiveMode = "serial_turn" | "parallel_round";

export type OrchestratorCommand =
  | { type: "cmd.start"; meeting_id: string }
  | { type: "cmd.abort"; meeting_id: string; reason?: string }
  | { type: "cmd.user_message"; meeting_id: string; content: string };

export type OrchestratorEvent =
  | { type: "evt.round_complete"; round: number }
  | { type: "evt.vote_accepted"; avg_score: number }
  | { type: "evt.vote_rejected"; avg_score: number }
  | { type: "evt.vote_aborted"; reason: string }
  | { type: "evt.max_rounds_reached" }
  | { type: "evt.error"; code: string; message: string };

export type TransitionSpec = {
  from: MeetingState | "*";
  on: OrchestratorCommand["type"] | OrchestratorEvent["type"];
  to: MeetingState | "SAME";
  notes?: string;
};

export const TRANSITIONS: readonly TransitionSpec[] = [
  { from: "DRAFT", on: "cmd.start", to: "RUNNING_DISCUSSION" },
  { from: "RUNNING_DISCUSSION", on: "cmd.user_message", to: "SAME" },
  { from: "RUNNING_DISCUSSION", on: "evt.round_complete", to: "RUNNING_VOTE" },
  { from: "RUNNING_VOTE", on: "cmd.user_message", to: "RUNNING_DISCUSSION", notes: "Interrupt vote" },
  { from: "RUNNING_VOTE", on: "evt.vote_accepted", to: "FINISHED_ACCEPTED" },
  { from: "RUNNING_VOTE", on: "evt.vote_rejected", to: "RUNNING_DISCUSSION" },
  { from: "RUNNING_VOTE", on: "evt.vote_aborted", to: "RUNNING_DISCUSSION" },
  { from: "RUNNING_DISCUSSION", on: "evt.max_rounds_reached", to: "FINISHED_ABORTED" },
  { from: "*", on: "cmd.abort", to: "FINISHED_ABORTED" },
  { from: "*", on: "evt.error", to: "SAME" },
];
