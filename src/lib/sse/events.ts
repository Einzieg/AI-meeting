import { z } from "zod";
import { MeetingStateSchema, MessageSchema, VoteSchema } from "../domain/models";

// ── SSE Event Data (discriminated union) ──

export const SseEventDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ping"),
    payload: z.object({}).default({}),
  }),
  z.object({
    type: z.literal("meeting.state_changed"),
    payload: z.object({
      state: MeetingStateSchema,
      round: z.number().int().min(0),
      stage_version: z.number().int().min(0),
    }),
  }),
  z.object({
    type: z.literal("message.delta"),
    payload: z.object({
      message_id: z.string().min(1),
      agent_id: z.string().min(1).optional(),
      delta: z.string(),
    }),
  }),
  z.object({
    type: z.literal("message.final"),
    payload: z.object({
      message: MessageSchema,
    }),
  }),
  z.object({
    type: z.literal("facilitator.output"),
    payload: z.object({
      stage_version: z.number().int().min(0),
      round: z.number().int().min(0),
      output: z.unknown(),
    }),
  }),
  z.object({
    type: z.literal("vote.session_started"),
    payload: z.object({
      vote_session_id: z.string().min(1),
      stage_version: z.number().int().min(0),
    }),
  }),
  z.object({
    type: z.literal("vote.received"),
    payload: z.object({
      vote: VoteSchema,
    }),
  }),
  z.object({
    type: z.literal("vote.session_final"),
    payload: z.object({
      vote_session_id: z.string().min(1),
      stage_version: z.number().int().min(0),
      accepted: z.boolean(),
      avg_score: z.number().min(0).max(100),
      reason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("error"),
    payload: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      details: z.unknown().optional(),
    }),
  }),
]);
export type SseEventData = z.infer<typeof SseEventDataSchema>;

// ── SSE Event Envelope ──

export type SseEventEnvelope = {
  id: number;
  meeting_id: string;
  at: string;
};

export type SseEvent = SseEventEnvelope & {
  type: SseEventData["type"];
  payload: SseEventData["payload"];
};

export type SseEventToAppend = Omit<SseEventEnvelope, "id"> & {
  type: SseEventData["type"];
  payload: SseEventData["payload"];
};
