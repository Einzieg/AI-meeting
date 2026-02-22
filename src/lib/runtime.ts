import { InMemoryStore } from "./storage/in-memory-store";
import { LLMRegistry } from "./llm/registry";
import { MockProvider } from "./llm/mock-provider";
import { OpenAIProvider } from "./llm/openai-provider";
import { AnthropicProvider } from "./llm/anthropic-provider";
import { GeminiProvider } from "./llm/gemini-provider";
import type { Store } from "./storage/store";
import type { LLMClient } from "./llm/types";
import { MeetingRunner } from "./orchestrator/runner";
import type { SseEventToAppend } from "./sse/events";

// ── Singleton instances (process-scoped) ──

let store: Store | null = null;
let registry: LLMRegistry | null = null;
const runners = new Map<string, MeetingRunner>();
const sseListeners = new Map<string, Set<(event: SseEventToAppend) => void>>();

export function getStore(): Store {
  if (!store) {
    store = new InMemoryStore();
  }
  return store;
}

export function getLLMRegistry(): LLMRegistry {
  if (!registry) {
    registry = new LLMRegistry();

    // Always register Mock
    registry.register(new MockProvider({
      default_style: "neutral",
      per_agent_style: {
        "agent-1": "optimist",
        "agent-2": "skeptic",
        "agent-3": "creative",
        "agent-4": "strict",
        "agent-5": "neutral",
      },
      latency_ms: 300,
    }));

    // Register real providers when API keys are configured
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      registry.register(new OpenAIProvider({
        api_key: openaiKey,
        base_url: process.env.OPENAI_BASE_URL,
      }));
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      registry.register(new AnthropicProvider({
        api_key: anthropicKey,
        base_url: process.env.ANTHROPIC_BASE_URL,
      }));
    }

    const geminiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (geminiKey) {
      registry.register(new GeminiProvider({
        api_key: geminiKey,
        base_url: process.env.GOOGLE_GEMINI_BASE_URL,
      }));
    }
  }
  return registry;
}

export function getLLMClient(): LLMClient {
  return getLLMRegistry();
}

export function getRunner(meetingId: string): MeetingRunner | undefined {
  return runners.get(meetingId);
}

export function createRunner(meetingId: string): MeetingRunner {
  const runner = new MeetingRunner(getStore(), getLLMClient(), {
    onEvent: (event: SseEventToAppend) => {
      const listeners = sseListeners.get(meetingId);
      if (listeners) {
        for (const listener of listeners) {
          listener(event);
        }
      }
    },
  });
  runners.set(meetingId, runner);
  return runner;
}

export function addSseListener(meetingId: string, listener: (event: SseEventToAppend) => void): () => void {
  if (!sseListeners.has(meetingId)) {
    sseListeners.set(meetingId, new Set());
  }
  sseListeners.get(meetingId)!.add(listener);
  return () => {
    sseListeners.get(meetingId)?.delete(listener);
  };
}
