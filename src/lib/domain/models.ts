import { z } from "zod";
import { MeetingConfigSchema } from "./config";

const Id = z.string().min(1);
const IsoDateTimeStr = z.string().min(1);

// ── Meeting State ──

export const MeetingStateSchema = z.enum([
  "DRAFT",
  "RUNNING_DISCUSSION",
  "RUNNING_VOTE",
  "FINISHED_ACCEPTED",
  "FINISHED_ABORTED",
]);
export type MeetingState = z.infer<typeof MeetingStateSchema>;

// ── Meeting Result ──

export const MeetingResultSchema = z.object({
  accepted: z.boolean(),
  concluded_at: IsoDateTimeStr,
  summary_markdown: z.string().optional(),
  summary_json: z.unknown().optional(),
  reason: z.string().optional(),
});
export type MeetingResult = z.infer<typeof MeetingResultSchema>;

// ── Meeting ──

export const MeetingSchema = z.object({
  id: Id,
  topic: z.string().min(1).max(2000),
  state: MeetingStateSchema,
  config: MeetingConfigSchema,
  created_at: IsoDateTimeStr,
  updated_at: IsoDateTimeStr,
  round: z.number().int().min(0).default(0),
  stage_version: z.number().int().min(0).default(0),
  effective_discussion_mode: z
    .enum(["serial_turn", "parallel_round"])
    .optional(),
  active_vote_session_id: Id.nullable().optional(),
  result: MeetingResultSchema.optional(),
});
export type Meeting = z.output<typeof MeetingSchema>;

// ── Message ──

export const MessageRoleSchema = z.enum(["user", "agent", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ReplyTargetSchema = z.object({
  agent_id: Id,
  message_id: Id.optional(),
  quote: z.string().max(2000).optional(),
});
export type ReplyTarget = z.infer<typeof ReplyTargetSchema>;

export const MessageMetaSchema = z.object({
  round: z.number().int().min(0),
  turn_index: z.number().int().min(0).optional(),
  discussion_mode: z.enum(["serial_turn", "parallel_round"]).optional(),
  reply_targets: z.array(ReplyTargetSchema).default([]),
  token_usage: z
    .object({
      prompt_tokens: z.number().int().optional(),
      completion_tokens: z.number().int().optional(),
      total_tokens: z.number().int().optional(),
    })
    .optional(),
  latency_ms: z.number().int().optional(),
  provider_request_id: z.string().optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

export const MessageSchema = z.object({
  id: Id,
  meeting_id: Id,
  created_at: IsoDateTimeStr,
  role: MessageRoleSchema,
  agent_id: Id.optional(),
  system_id: z.enum(["facilitator", "orchestrator"]).optional(),
  content: z.string().max(50_000),
  meta: MessageMetaSchema,
});
export type Message = z.output<typeof MessageSchema>;

// ── Vote ──

export const VoteSchema = z.object({
  id: Id,
  meeting_id: Id,
  vote_session_id: Id,
  voter_agent_id: Id,
  score: z.number().int().min(0).max(100),
  pass: z.boolean(),
  rationale: z.string().max(10_000).optional(),
  stage_version: z.number().int().min(0),
  created_at: IsoDateTimeStr,
});
export type Vote = z.output<typeof VoteSchema>;
