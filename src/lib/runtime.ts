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

type RuntimeState = {
  store: Store;
  registry: LLMRegistry | null;
  runners: Map<string, MeetingRunner>;
  sseListeners: Map<string, Set<(event: SseEventToAppend) => void>>;
};

declare global {
  // Persist runtime state across Next.js dev hot-reloads/module reloads.
  var __aiMeetingRuntime: RuntimeState | undefined;
}

function getRuntimeState(): RuntimeState {
  if (!globalThis.__aiMeetingRuntime) {
    globalThis.__aiMeetingRuntime = {
      store: new InMemoryStore(),
      registry: null,
      runners: new Map(),
      sseListeners: new Map(),
    };
  }
  return globalThis.__aiMeetingRuntime;
}

export function getStore(): Store {
  return getRuntimeState().store;
}

export function getLLMRegistry(): LLMRegistry {
  const runtime = getRuntimeState();

  if (!runtime.registry) {
    runtime.registry = new LLMRegistry();

    // Always register Mock
    runtime.registry.register(new MockProvider({
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
      runtime.registry.register(new OpenAIProvider({
        api_key: openaiKey,
        base_url: process.env.OPENAI_BASE_URL,
      }));
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      runtime.registry.register(new AnthropicProvider({
        api_key: anthropicKey,
        base_url: process.env.ANTHROPIC_BASE_URL,
      }));
    }

    const geminiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (geminiKey) {
      runtime.registry.register(new GeminiProvider({
        api_key: geminiKey,
        base_url: process.env.GOOGLE_GEMINI_BASE_URL,
      }));
    }
  }

  return runtime.registry;
}

export function getLLMClient(): LLMClient {
  return getLLMRegistry();
}

export function getRunner(meetingId: string): MeetingRunner | undefined {
  return getRuntimeState().runners.get(meetingId);
}

export function createRunner(meetingId: string): MeetingRunner {
  const runtime = getRuntimeState();

  const runner = new MeetingRunner(getStore(), getLLMClient(), {
    onEvent: (event: SseEventToAppend) => {
      const listeners = runtime.sseListeners.get(meetingId);
      if (listeners) {
        for (const listener of listeners) {
          listener(event);
        }
      }
    },
  });

  runtime.runners.set(meetingId, runner);
  return runner;
}

export function addSseListener(meetingId: string, listener: (event: SseEventToAppend) => void): () => void {
  const runtime = getRuntimeState();

  if (!runtime.sseListeners.has(meetingId)) {
    runtime.sseListeners.set(meetingId, new Set());
  }

  runtime.sseListeners.get(meetingId)!.add(listener);

  return () => {
    runtime.sseListeners.get(meetingId)?.delete(listener);
  };
}
