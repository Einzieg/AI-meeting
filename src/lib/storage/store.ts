import type { MeetingConfig } from "../domain/config";
import type { MeetingId, EventId } from "../domain/ids";
import type { Meeting, MeetingResult, Message, Vote } from "../domain/models";
import type { VoteSession, VoteSessionStatus } from "../voting/types";
import type { SseEvent, SseEventToAppend } from "../sse/events";

export type MeetingUpdatePatch = Partial<
  Pick<
    Meeting,
    | "state"
    | "round"
    | "stage_version"
    | "effective_discussion_mode"
    | "active_vote_session_id"
    | "result"
    | "updated_at"
  >
>;

export interface Store {
  // ── Locking ──
  withMeetingLock<T>(meetingId: MeetingId, fn: () => Promise<T>): Promise<T>;

  // ── Meetings ──
  createMeeting(input: { topic: string; config: MeetingConfig }): Promise<Meeting>;
  getMeeting(meetingId: MeetingId): Promise<Meeting | null>;
  listMeetings(input?: { limit?: number; cursor?: string }): Promise<{
    items: Meeting[];
    next_cursor: string | null;
  }>;
  updateMeeting(meetingId: MeetingId, patch: MeetingUpdatePatch): Promise<Meeting>;

  // ── Messages ──
  appendMessage(message: Message): Promise<void>;
  listMessages(input: {
    meeting_id: MeetingId;
    limit?: number;
    after_message_id?: string;
  }): Promise<{ items: Message[] }>;

  // ── Vote Sessions ──
  createVoteSession(session: VoteSession): Promise<void>;
  getVoteSession(meetingId: MeetingId, voteSessionId: string): Promise<VoteSession | null>;
  finalizeVoteSession(input: {
    meeting_id: MeetingId;
    vote_session_id: string;
    status: "FINALIZED" | "ABORTED" | "INCOMPLETE";
    ended_at: string;
  }): Promise<void>;

  // ── Votes ──
  appendVote(vote: Vote): Promise<void>;
  listVotes(input: {
    meeting_id: MeetingId;
    vote_session_id?: string;
  }): Promise<{ items: Vote[] }>;

  // ── SSE Events ──
  appendEvent(event: SseEventToAppend): Promise<SseEvent>;
  listEvents(input: {
    meeting_id: MeetingId;
    after?: EventId;
    limit?: number;
  }): Promise<{ items: SseEvent[]; last_id: EventId | null }>;
}
