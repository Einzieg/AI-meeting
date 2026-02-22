"use client";

import { create } from "zustand";
import type { Message, Vote, MeetingState } from "@/lib/domain/models";
import type { MeetingConfig } from "@/lib/domain/config";

export type MeetingDetail = {
  id: string;
  topic: string;
  state: MeetingState;
  config: MeetingConfig;
  round: number;
  stage_version: number;
  effective_discussion_mode?: "serial_turn" | "parallel_round";
  result?: {
    accepted: boolean;
    concluded_at: string;
    summary_markdown?: string;
    reason?: string;
  };
};

type AgentUIStatus = "idle" | "thinking" | "done";

interface MeetingStore {
  meeting: MeetingDetail | null;
  messages: Message[];
  votes: Vote[];
  isConnected: boolean;
  agentStatuses: Record<string, AgentUIStatus>;

  setMeeting: (meeting: MeetingDetail) => void;
  addMessage: (message: Message) => void;
  setMessages: (messages: Message[]) => void;
  addVote: (vote: Vote) => void;
  setVotes: (votes: Vote[]) => void;
  updateMeetingState: (state: MeetingState, round: number, stageVersion: number) => void;
  setConnected: (connected: boolean) => void;
  setAgentStatus: (agentId: string, status: AgentUIStatus) => void;
  reset: () => void;
}

export const useMeetingStore = create<MeetingStore>((set) => ({
  meeting: null,
  messages: [],
  votes: [],
  isConnected: false,
  agentStatuses: {},

  setMeeting: (meeting) => set({ meeting }),
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),
  setMessages: (messages) => set({ messages }),
  addVote: (vote) =>
    set((s) => ({ votes: [...s.votes, vote] })),
  setVotes: (votes) => set({ votes }),
  updateMeetingState: (state, round, stageVersion) =>
    set((s) => ({
      meeting: s.meeting ? { ...s.meeting, state, round, stage_version: stageVersion } : null,
    })),
  setConnected: (isConnected) => set({ isConnected }),
  setAgentStatus: (agentId, status) =>
    set((s) => ({
      agentStatuses: { ...s.agentStatuses, [agentId]: status },
    })),
  reset: () =>
    set({ meeting: null, messages: [], votes: [], isConnected: false, agentStatuses: {} }),
}));
