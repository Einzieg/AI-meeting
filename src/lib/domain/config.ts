import { z } from "zod";

// ── Agent ──

export const AgentConfigSchema = z.object({
  id: z.string().min(1).max(50),
  display_name: z.string().min(1).max(100),
  provider: z.string().min(1).max(50),
  model: z.string().min(1).max(120),
  system_prompt: z.string().min(1).max(10_000),
  temperature: z.number().min(0).max(2).default(0.7),
  max_output_tokens: z.number().int().min(64).max(16384).default(2048),
  enabled: z.boolean().default(true),
});
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type AgentConfig = z.output<typeof AgentConfigSchema>;

// ── Discussion ──

export const DiscussionModeSchema = z.enum([
  "auto",
  "serial_turn",
  "parallel_round",
]);
export type DiscussionMode = z.infer<typeof DiscussionModeSchema>;

export const DiscussionConfigSchema = z
  .object({
    mode: DiscussionModeSchema.default("auto"),
    auto_parallel_min_agents: z.number().int().min(2).max(20).default(6),
    cross_reply_targets_per_agent: z.number().int().min(0).max(5).default(2),
    rolling_summary_enabled: z.boolean().default(true),
    rolling_summary_max_chars: z.number().int().min(200).max(5000).default(1000),
  })
  .default({});
export type DiscussionConfigInput = z.input<typeof DiscussionConfigSchema>;
export type DiscussionConfig = z.output<typeof DiscussionConfigSchema>;

// ── Facilitator ──

export const FacilitatorConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: z.string().min(1).max(50).optional(),
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    max_output_tokens: z.number().int().min(64).max(8192).default(800),
    timeout_ms: z.number().int().min(5_000).max(300_000).default(90_000),
  })
  .default({});
export type FacilitatorConfigInput = z.input<typeof FacilitatorConfigSchema>;
export type FacilitatorConfig = z.output<typeof FacilitatorConfigSchema>;

// ── Output ──

export const OutputFormatSchema = z.enum(["markdown", "json", "markdown+json"]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const OutputConfigSchema = z
  .object({
    format: OutputFormatSchema.default("markdown"),
  })
  .default({});
export type OutputConfigInput = z.input<typeof OutputConfigSchema>;
export type OutputConfig = z.output<typeof OutputConfigSchema>;

// ── Threshold ──

export const ThresholdModeSchema = z.enum(["avg_score"]);
export type ThresholdMode = z.infer<typeof ThresholdModeSchema>;

export const ThresholdConfigSchema = z
  .object({
    mode: ThresholdModeSchema.default("avg_score"),
    avg_score_threshold: z.number().int().min(0).max(100).default(80),
    min_rounds: z.number().int().min(0).max(100).default(2),
    max_rounds: z.number().int().min(1).max(100).default(8),
    vote_timeout_ms: z.number().int().min(1_000).max(300_000).default(60_000),
  })
  .superRefine((val, ctx) => {
    if (val.max_rounds < val.min_rounds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`max_rounds` must be >= `min_rounds`",
        path: ["max_rounds"],
      });
    }
  })
  .default({});
export type ThresholdConfigInput = z.input<typeof ThresholdConfigSchema>;
export type ThresholdConfig = z.output<typeof ThresholdConfigSchema>;

// ── Meeting Config (top-level) ──

export const MeetingConfigSchema = z
  .object({
    agents: z.array(AgentConfigSchema).min(3).max(8),
    discussion: DiscussionConfigSchema.default({}),
    facilitator: FacilitatorConfigSchema.default({}),
    output: OutputConfigSchema.default({}),
    threshold: ThresholdConfigSchema.default({}),
  })
  .superRefine((val, ctx) => {
    const ids = new Set<string>();
    for (const agent of val.agents) {
      if (ids.has(agent.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate agent id: ${agent.id}`,
          path: ["agents"],
        });
      }
      ids.add(agent.id);
    }
  });
export type MeetingConfigInput = z.input<typeof MeetingConfigSchema>;
export type MeetingConfig = z.output<typeof MeetingConfigSchema>;
