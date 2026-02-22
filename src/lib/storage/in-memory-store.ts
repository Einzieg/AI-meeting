import { nanoid } from "nanoid";
import type { MeetingConfig } from "../domain/config";
import type { MeetingId, EventId } from "../domain/ids";
import type { Meeting, Message, Vote } from "../domain/models";
import type { VoteSession } from "../voting/types";
import type { SseEvent, SseEventToAppend } from "../sse/events";
import type { Store, MeetingUpdatePatch } from "./store";

export class InMemoryStore implements Store {
  private meetings = new Map<string, Meeting>();
  private messages: Message[] = [];
  private voteSessions = new Map<string, VoteSession>();
  private votes: Vote[] = [];
  private events: SseEvent[] = [];
  private eventCounter = 0;
  private locks = new Map<string, Promise<unknown>>();

  async withMeetingLock<T>(meetingId: MeetingId, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(meetingId) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => (resolve = r));
    this.locks.set(meetingId, next);
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  async createMeeting(input: { topic: string; config: MeetingConfig }): Promise<Meeting> {
    const now = new Date().toISOString();
    const meeting: Meeting = {
      id: nanoid(),
      topic: input.topic,
      state: "DRAFT",
      config: input.config,
      created_at: now,
      updated_at: now,
      round: 0,
      stage_version: 0,
      effective_discussion_mode: undefined,
      active_vote_session_id: undefined,
      result: undefined,
    };
    this.meetings.set(meeting.id, meeting);
    return meeting;
  }

  async getMeeting(meetingId: MeetingId): Promise<Meeting | null> {
    return this.meetings.get(meetingId) ?? null;
  }

  async listMeetings(input?: { limit?: number; cursor?: string }): Promise<{
    items: Meeting[];
    next_cursor: string | null;
  }> {
    const limit = input?.limit ?? 20;
    const all = Array.from(this.meetings.values()).sort(
      (a, b) => b.created_at.localeCompare(a.created_at)
    );
    let start = 0;
    if (input?.cursor) {
      const idx = all.findIndex((m) => m.id === input.cursor);
      if (idx >= 0) start = idx + 1;
    }
    const items = all.slice(start, start + limit);
    const next_cursor = start + limit < all.length ? items[items.length - 1]?.id ?? null : null;
    return { items, next_cursor };
  }

  async updateMeeting(meetingId: MeetingId, patch: MeetingUpdatePatch): Promise<Meeting> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    const updated = {
      ...meeting,
      ...patch,
      updated_at: patch.updated_at ?? new Date().toISOString(),
    };
    this.meetings.set(meetingId, updated);
    return updated;
  }

  async appendMessage(message: Message): Promise<void> {
    this.messages.push(message);
  }

  async listMessages(input: {
    meeting_id: MeetingId;
    limit?: number;
    after_message_id?: string;
  }): Promise<{ items: Message[] }> {
    let filtered = this.messages.filter((m) => m.meeting_id === input.meeting_id);
    if (input.after_message_id) {
      const idx = filtered.findIndex((m) => m.id === input.after_message_id);
      if (idx >= 0) filtered = filtered.slice(idx + 1);
    }
    if (input.limit) filtered = filtered.slice(0, input.limit);
    return { items: filtered };
  }

  async createVoteSession(session: VoteSession): Promise<void> {
    this.voteSessions.set(session.id, session);
  }

  async getVoteSession(meetingId: MeetingId, voteSessionId: string): Promise<VoteSession | null> {
    const s = this.voteSessions.get(voteSessionId);
    if (!s || s.meeting_id !== meetingId) return null;
    return s;
  }

  async finalizeVoteSession(input: {
    meeting_id: MeetingId;
    vote_session_id: string;
    status: "FINALIZED" | "ABORTED" | "INCOMPLETE";
    ended_at: string;
  }): Promise<void> {
    const s = this.voteSessions.get(input.vote_session_id);
    if (!s || s.meeting_id !== input.meeting_id) return;
    this.voteSessions.set(input.vote_session_id, {
      ...s,
      status: input.status,
      ended_at: input.ended_at,
    });
  }

  async appendVote(vote: Vote): Promise<void> {
    this.votes.push(vote);
  }

  async listVotes(input: {
    meeting_id: MeetingId;
    vote_session_id?: string;
  }): Promise<{ items: Vote[] }> {
    let filtered = this.votes.filter((v) => v.meeting_id === input.meeting_id);
    if (input.vote_session_id) {
      filtered = filtered.filter((v) => v.vote_session_id === input.vote_session_id);
    }
    return { items: filtered };
  }

  async appendEvent(event: SseEventToAppend): Promise<SseEvent> {
    const id = ++this.eventCounter;
    const sseEvent: SseEvent = { ...event, id };
    this.events.push(sseEvent);
    return sseEvent;
  }

  async listEvents(input: {
    meeting_id: MeetingId;
    after?: EventId;
    limit?: number;
  }): Promise<{ items: SseEvent[]; last_id: EventId | null }> {
    let filtered = this.events.filter((e) => e.meeting_id === input.meeting_id);
    if (input.after !== undefined) {
      filtered = filtered.filter((e) => e.id > input.after!);
    }
    if (input.limit) filtered = filtered.slice(0, input.limit);
    const last_id = filtered.length > 0 ? filtered[filtered.length - 1].id : null;
    return { items: filtered, last_id };
  }
}
