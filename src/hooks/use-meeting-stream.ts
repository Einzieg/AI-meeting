"use client";

import { useEffect, useRef } from "react";
import { useMeetingStore } from "@/store/meeting-store";

export function useMeetingStream(meetingId: string | null) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { addMessage, addVote, updateMeetingState, setConnected } = useMeetingStore();

  useEffect(() => {
    if (!meetingId) return;

    let unmounted = false;

    const connect = () => {
      if (unmounted) return;

      const es = new EventSource(`/api/meetings/${meetingId}/events`);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (!unmounted) setConnected(true);
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        if (!unmounted) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      };

      es.addEventListener("message.final", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          addMessage(data.payload.message);
        } catch { /* ignore */ }
      });

      es.addEventListener("meeting.state_changed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          updateMeetingState(data.payload.state, data.payload.round, data.payload.stage_version);
        } catch { /* ignore */ }
      });

      es.addEventListener("vote.received", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          addVote(data.payload.vote);
        } catch { /* ignore */ }
      });
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      setConnected(false);
    };
  }, [meetingId, addMessage, addVote, updateMeetingState, setConnected]);
}
