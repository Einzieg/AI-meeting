import { z } from "zod";
import type { Message } from "../domain/models";

export const FacilitatorOutputSchema = z.object({
  disagreements: z.array(z.string().min(1).max(500)).min(1).max(3),
  proposed_patch: z.string().min(1).max(4000),
  next_focus: z.array(z.string().min(1).max(300)).min(1).max(2),
  round_summary: z.string().min(1).max(2000),
});
export type FacilitatorOutput = z.infer<typeof FacilitatorOutputSchema>;

export type FacilitatorInput = {
  meeting_id: string;
  topic: string;
  round: number;
  stage_version: number;
  proposal_text: string;
  recent_messages: Message[];
  rolling_summary?: string;
  vote_summary?: {
    avg_score: number;
    min_score: number;
    max_score: number;
  };
};
