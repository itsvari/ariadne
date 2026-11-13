"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BrainCircuit,
  Mic,
  MicOff,
  Play,
  Power,
  Radio,
  Send,
  Square,
  Terminal,
  Volume2,
} from 'lucide-react';
import type { BeliefStore } from '@ariadne/shared-contracts';
import { useFluxSTT } from '../hooks/useFluxSTT';
import { DEFAULT_SERVER_URL, eventSocketUrl, serverUrl } from '../lib/server';
import type {
  AgentActivityEntry,
  DashboardState,
  Message,
  SessionEvent,
  DashboardSessionStatus,
  SystemEvent,
} from '../lib/types';

const SESSION_ID_STORAGE_KEY = 'ariadne-session-id';
const INTERVAL_OPTIONS = [30, 60, 120];
const DASHBOARD_REFRESH_INTERVAL_MS = 5000;
const MAX_ACTIVITY_ENTRIES = 200;
const MAX_EVENT_LOG_ENTRIES = 150;
const INT16_MIN = 0x8000;
const INT16_RANGE = 0x10000;

// -- helpers ---------------------------------------------------------------

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + '…';
}

// -- component -------------------------------------------------------------

export default function AriadneControlPanel() {
  const [sessionId, setSessionId] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [activity, setActivity] = useState<AgentActivityEntry[]>([]);
  const [status, setStatus] = useState<DashboardSessionStatus | null>(null);
  const [beliefStore, setBeliefStore] = useState<BeliefStore | null>(null);
  const [pendingDirectives, setPendingDirectives] = useState<DashboardState['directives']['pending']>([]);
  const [fulfilledDirectives, setFulfilledDirectives] = useState<DashboardState['directives']['fulfilled']>([]);
  const [interventionMode, setInterventionMode] = useState<'control' | 'light'>('light');
  const [thinkerIntervalSec, setThinkerIntervalSec] = useState(60);
  const [isBusy, setIsBusy] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const activityEndRef = useRef<HTMLDivElement | null>(null);
  const eventsEndRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef(0);
  const ttsEncodingRef = useRef('linear16');
  const ttsSampleRateRef = useRef(24000);
  const ttsChannelsRef = useRef(1);
  const ttsChunkCountRef = useRef(0);
  const audioQueueRef = useRef<Array<{ data: Uint8Array; sampleRateHz: number; channels: number }>>([]);
  const isAppendingRef = useRef(false);

  // -- audio pipeline -------------------------------------------------------

  const resumeAudioPlayback = useCallback(() => {
    const audioContext = audioContextRef.current;
    if (!audioContext) {
      return;
    }
    void audioContext.resume().catch((error) => {
      console.warn('Audio context resume blocked:', error);
    });
  }, []);

  const decodePcmSamples = useCallback((chunk: Uint8Array, channels: number, sampleRateHz: number): AudioBuffer | null => {
    const audioContext = audioContextRef.current;
    if (!audioContext) {
      return null;
    }
    if (channels < 1 || channels > 2) {
      return null;
    }

    const totalSampleCount = Math.floor(chunk.byteLength / 2);
    const frameCount = Math.floor(totalSampleCount / channels);
    if (frameCount <= 0) {
      return null;
    }

    const audioBuffer = audioContext.createBuffer(channels, frameCount, sampleRateHz);
    const channelData = Array.from({ length: channels }, (_, index) => audioBuffer.getChannelData(index));

    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sampleIndex = frame * channels + channel;
        const byteIndex = sampleIndex * 2;
        const low = chunk[byteIndex];
        const high = chunk[byteIndex + 1];
        let sample = (high << 8) | low;
        if (sample >= INT16_MIN) {
          sample -= INT16_RANGE;
        }
        channelData[channel][frame] = sample / INT16_MIN;
      }
    }

    return audioBuffer;
  }, []);

  const flushAudioQueue = useCallback(() => {
    const audioContext = audioContextRef.current;
    if (!audioContext || isAppendingRef.current) {
      return;
    }

    isAppendingRef.current = true;

    try {
      while (audioQueueRef.current.length > 0) {
        const queuedChunk = audioQueueRef.current.shift();
        if (!queuedChunk || queuedChunk.data.byteLength < 2) {
          continue;
        }

        if (ttsEncodingRef.current !== 'linear16') {
          continue;
        }

        const { data: chunk, sampleRateHz, channels } = queuedChunk;
        const audioBuffer = decodePcmSamples(chunk, channels, sampleRateHz);
        if (!audioBuffer) {
          continue;
        }

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        const now = audioContext.currentTime;
        const startAt = Math.max(now, nextPlaybackTimeRef.current);
        source.start(startAt);
        nextPlaybackTimeRef.current = startAt + audioBuffer.duration;
      }
    } catch (error) {
      console.error('Failed to process PCM TTS chunk', error);
    } finally {
      isAppendingRef.current = false;
    }
  }, [decodePcmSamples]);

  const ensureAudioPipeline = useCallback(() => {
    if (audioContextRef.current) {
      resumeAudioPlayback();
      return;
    }

    const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    const audioContext = new AudioContextCtor();
    audioContextRef.current = audioContext;
    nextPlaybackTimeRef.current = audioContext.currentTime;
    setAudioReady(true);
    resumeAudioPlayback();
    flushAudioQueue();
  }, [flushAudioQueue, resumeAudioPlayback]);

  useEffect(() => {
    return () => {
      const audioContext = audioContextRef.current;
      if (!audioContext) {
        return;
      }
      void audioContext.close();
      audioContextRef.current = null;
    };
  }, []);

  // -- session init ---------------------------------------------------------

  useEffect(() => {
    const querySessionId = new URLSearchParams(window.location.search).get('sessionId')?.trim();
    const savedSessionId = window.localStorage.getItem(SESSION_ID_STORAGE_KEY)?.trim();
    setSessionId(querySessionId || savedSessionId || 'default');
  }, []);

  useEffect(() => {
    if (status) {
      if (status.interventionMode) setInterventionMode(status.interventionMode);
      if (status.thinkerIntervalSec) setThinkerIntervalSec(status.thinkerIntervalSec);
    }
  }, [status]);

  useEffect(() => {
    if (sessionId) {
      window.localStorage.setItem(SESSION_ID_STORAGE_KEY, sessionId);
    }
  }, [sessionId]);

  // -- auto-scroll (using useLayoutEffect for instant DOM scroll) -----------

  useLayoutEffect(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [messages]);

  useLayoutEffect(() => {
    requestAnimationFrame(() => {
      activityEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [activity]);

  useLayoutEffect(() => {
    requestAnimationFrame(() => {
      eventsEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [events]);

  // -- event helpers --------------------------------------------------------

  const addEvent = useCallback((type: string, details: string) => {
    setEvents((current) => {
      const next = [
        ...current,
        {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          type,
          details,
        },
      ];
      if (next.length > MAX_EVENT_LOG_ENTRIES) {
        return next.slice(next.length - MAX_EVENT_LOG_ENTRIES);
      }
      return next;
    });
  }, []);

  const addActivity = useCallback((entry: AgentActivityEntry) => {
    setActivity((current) => {
      const next = [...current, entry];
      if (next.length > MAX_ACTIVITY_ENTRIES) {
        return next.slice(next.length - MAX_ACTIVITY_ENTRIES);
      }
      return next;
    });
  }, []);

  // -- dashboard refresh ----------------------------------------------------

  const refreshDashboard = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    try {
      const [statusResponse, beliefResponse, directivesResponse] = await Promise.all([
        fetch(serverUrl(`/session/status?sessionId=${sessionId}`)),
        fetch(serverUrl(`/belief-store?sessionId=${sessionId}`)),
        fetch(serverUrl(`/directives?sessionId=${sessionId}`)),
      ]);

      if (statusResponse.ok) {
        const statusPayload = (await statusResponse.json()) as { status: DashboardSessionStatus };
        setStatus(statusPayload.status);
      }

      if (beliefResponse.ok) {
        setBeliefStore((await beliefResponse.json()) as BeliefStore);
      }

      if (directivesResponse.ok) {
        const directivesPayload = (await directivesResponse.json()) as DashboardState['directives'];
        setPendingDirectives(directivesPayload.pending);
        setFulfilledDirectives(directivesPayload.fulfilled);
      }
    } catch (error) {
      console.error(error);
    }
  }, [sessionId]);

  // -- websocket event handlers ---------------------------------------------

  const updateConnectedClients = useCallback((connectedClients: number) => {
    setStatus((currentStatus) => {
      if (!currentStatus) {
        return currentStatus;
      }
      return { ...currentStatus, connectedClients };
    });
  }, []);

  const handleSessionJoined = useCallback((event: SessionEvent) => {
    const payload = event.payload as { connectedClients?: number };
    if (typeof payload.connectedClients === 'number') {
      updateConnectedClients(payload.connectedClients);
    }
  }, [updateConnectedClients]);

  const handleSessionLeft = useCallback((event: SessionEvent) => {
    const payload = event.payload as { connectedClients?: number };
    if (typeof payload.connectedClients === 'number') {
      updateConnectedClients(payload.connectedClients);
    }
  }, [updateConnectedClients]);

  const handleUtteranceFinal = useCallback((event: SessionEvent) => {
    const payload = event.payload as { text: string; speakerId?: string };
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: payload.text,
        speakerId: payload.speakerId,
      },
    ]);
    addEvent('UtteranceFinal', payload.text);
  }, [addEvent]);

  const handleTalkerOutput = useCallback((event: SessionEvent) => {
    const payload = event.payload as { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
    const rawContent = payload.content ?? '';

    const normalizedToolCalls = payload.tool_calls?.map((toolCall) => ({
      type: 'function' as const,
      function: toolCall.function,
    }));

    const speakCall = payload.tool_calls?.find((toolCall) => toolCall.function.name === 'speak');
    let spokenText: string | undefined;
    if (speakCall) {
      try {
        spokenText = (JSON.parse(speakCall.function.arguments) as { text?: string }).text ?? undefined;
      } catch {
        spokenText = undefined;
      }
    }

    const activityToolCalls = payload.tool_calls?.map((toolCall) => ({
      name: toolCall.function.name,
      args: toolCall.function.arguments,
    }));

    addActivity({
      kind: 'talker-output',
      id: crypto.randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      spokenText,
      reasoning: rawContent || undefined,
      toolCalls: activityToolCalls,
    });

    if (payload.tool_calls) {
      for (const toolCall of payload.tool_calls) {
        addActivity({
          kind: 'tool-call',
          id: crypto.randomUUID(),
          timestamp: event.timestamp ?? new Date().toISOString(),
          agent: 'talker',
          name: toolCall.function.name,
          args: toolCall.function.arguments,
        });
      }
    }

    if (rawContent && !spokenText) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: rawContent,
          toolCalls: normalizedToolCalls,
        },
      ]);
    }

    if (rawContent) {
      addEvent('TalkerResponse', rawContent);
    }
  }, [addEvent, addActivity]);

  const handleTtsAudioStart = useCallback((event: SessionEvent) => {
    const payload = event.payload as { encoding?: string; sampleRateHz?: number; channels?: number };
    ttsEncodingRef.current = payload.encoding ?? 'linear16';
    ttsSampleRateRef.current = payload.sampleRateHz ?? 24000;
    ttsChannelsRef.current = payload.channels ?? 1;
    ttsChunkCountRef.current = 0;
    audioQueueRef.current = [];

    const audioContext = audioContextRef.current;
    if (audioContext) {
      nextPlaybackTimeRef.current = audioContext.currentTime;
    }

    addActivity({
      kind: 'telemetry',
      id: crypto.randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      type: 'tts.start',
      summary: `${ttsEncodingRef.current} ${ttsSampleRateRef.current}Hz`,
    });
  }, [addActivity]);

  const handleTtsAudioChunk = useCallback((event: SessionEvent) => {
    ensureAudioPipeline();
    const payload = event.payload as {
      audioBase64: string;
      sampleRateHz?: number;
      channels?: number;
    };
    audioQueueRef.current.push({
      data: Uint8Array.from(atob(payload.audioBase64), (char) => char.charCodeAt(0)),
      sampleRateHz: payload.sampleRateHz ?? ttsSampleRateRef.current,
      channels: payload.channels ?? ttsChannelsRef.current,
    });
    ttsChunkCountRef.current += 1;
    resumeAudioPlayback();
    flushAudioQueue();
  }, [ensureAudioPipeline, flushAudioQueue, resumeAudioPlayback]);

  const handleTtsAudioDone = useCallback((event: SessionEvent) => {
    const audioContext = audioContextRef.current;
    if (audioContext) {
      nextPlaybackTimeRef.current = audioContext.currentTime;
    }
    audioQueueRef.current = [];

    addActivity({
      kind: 'telemetry',
      id: crypto.randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      type: 'tts.done',
      summary: `${ttsChunkCountRef.current} chunks`,
    });
    addEvent('TTS', `Stream complete: ${ttsChunkCountRef.current} chunks`);
  }, [addEvent, addActivity]);

  const handleSessionEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case 'session.status':
          setStatus(event.payload as DashboardSessionStatus);
          break;
        case 'client.joined':
          handleSessionJoined(event);
          break;
        case 'client.left':
          handleSessionLeft(event);
          break;
        case 'utterance.final':
          handleUtteranceFinal(event);
          break;
        case 'talker.output':
          handleTalkerOutput(event);
          break;
        case 'avatar.command':
          addEvent('AvatarCommand', JSON.stringify(event.payload));
          addActivity({
            kind: 'tool-call',
            id: crypto.randomUUID(),
            timestamp: event.timestamp ?? new Date().toISOString(),
            agent: 'talker',
            name: 'avatar_command',
            args: JSON.stringify(event.payload),
          });
          break;
        case 'reasoner.complete': {
          const reasonerPayload = event.payload as { reason?: string; directiveCount?: number; content?: string | null; toolCalls?: Array<{ function: { name: string; arguments: string } }> };
          addEvent('ReasonerComplete', JSON.stringify(event.payload));

          const rawContent = reasonerPayload.content ?? '';
          const activityToolCalls = reasonerPayload.toolCalls?.map((toolCall) => ({
            name: toolCall.function.name,
            args: toolCall.function.arguments,
          }));

          if (rawContent || activityToolCalls?.length) {
            setMessages((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: rawContent || '[Thinker ran - no text output]',
                speakerId: 'thinker',
                toolCalls: activityToolCalls?.map((tc) => ({
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.args },
                })),
              },
            ]);
          }

          addActivity({
            kind: 'thinker-complete',
            id: crypto.randomUUID(),
            timestamp: event.timestamp ?? new Date().toISOString(),
            reason: reasonerPayload.reason ?? 'unknown',
            directiveCount: reasonerPayload.directiveCount ?? 0,
            reasoning: rawContent || undefined,
            toolCalls: activityToolCalls,
          });

          if (reasonerPayload.toolCalls) {
            for (const toolCall of reasonerPayload.toolCalls) {
              addActivity({
                kind: 'tool-call',
                id: crypto.randomUUID(),
                timestamp: event.timestamp ?? new Date().toISOString(),
                agent: 'thinker',
                name: toolCall.function.name,
                args: toolCall.function.arguments,
              });
            }
          }

          void refreshDashboard();
          break;
        }
        case 'telemetry': {
          const telemetryPayload = event.payload as { type?: string; [key: string]: unknown };
          const telemetryType = telemetryPayload.type ?? 'telemetry';
          addEvent('Telemetry', JSON.stringify(event.payload));
          addActivity({
            kind: 'telemetry',
            id: crypto.randomUUID(),
            timestamp: event.timestamp ?? new Date().toISOString(),
            type: telemetryType,
            summary: summariseTelemetry(telemetryPayload),
          });
          break;
        }
        case 'speak': {
          const spokenText = String((event.payload as { text?: string }).text ?? '');
          addEvent('Speak', spokenText);
          if (spokenText) {
            setMessages((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: spokenText,
              },
            ]);
          }
          break;
        }
        case 'tts.audio.start':
          handleTtsAudioStart(event);
          break;
        case 'tts.audio.chunk':
          handleTtsAudioChunk(event);
          break;
        case 'tts.audio.done':
          handleTtsAudioDone(event);
          break;
        default:
          addEvent(event.type, JSON.stringify(event.payload));
      }
    },
    [addEvent, addActivity, handleSessionJoined, handleSessionLeft, handleUtteranceFinal, handleTalkerOutput, handleTtsAudioStart, handleTtsAudioChunk, handleTtsAudioDone, refreshDashboard],
  );

  // -- websocket connect ----------------------------------------------------

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    void refreshDashboard();

    const socket = new WebSocket(eventSocketUrl(sessionId));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as SessionEvent;
      handleSessionEvent(message);
    };

    socket.onerror = (event) => {
      const details = event instanceof ErrorEvent ? event.message : 'WebSocket error event';
      addEvent('SocketError', details);
      console.error('[events websocket] error:', event);
    };

    socket.onclose = (event) => {
      if (event.code !== 1000) {
        const details = `Closed (${event.code}) ${event.reason || 'no reason provided'}`;
        addEvent('SocketClosed', details);
        console.warn('[events websocket] closed:', details);
      }
    };

    return () => {
      socket.close();
    };
  }, [addEvent, handleSessionEvent, refreshDashboard, sessionId]);

  // -- periodic refresh -----------------------------------------------------

  useEffect(() => {
    if (!status?.active) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshDashboard();
    }, DASHBOARD_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [refreshDashboard, status?.active]);

  // -- actions --------------------------------------------------------------

  const startSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    ensureAudioPipeline();
    setIsBusy(true);
    try {
      const response = await fetch(serverUrl('/session/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          sessionConfig: { interventionMode, thinkerIntervalSec },
        }),
      });
      const payload = (await response.json()) as DashboardSessionStatus;
      setStatus(payload);
      addEvent('System', `Session started against ${DEFAULT_SERVER_URL}`);
      await refreshDashboard();
    } finally {
      setIsBusy(false);
    }
  }, [addEvent, ensureAudioPipeline, interventionMode, refreshDashboard, sessionId, thinkerIntervalSec]);

  const stopSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    setIsBusy(true);
    try {
      const response = await fetch(serverUrl('/session/stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const payload = (await response.json()) as DashboardSessionStatus;
      setStatus(payload);
      addEvent('System', 'Session stopped.');
      await refreshDashboard();
    } finally {
      setIsBusy(false);
    }
  }, [addEvent, refreshDashboard, sessionId]);

  const sendUtterance = useCallback(
    async (text: string, speakerId?: string) => {
      if (!sessionId || !text.trim()) {
        return;
      }

      ensureAudioPipeline();
      await fetch(serverUrl('/utterance'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, text: text.trim(), speakerId }),
      });
      setInput('');
    },
    [ensureAudioPipeline, sessionId],
  );

  const triggerThinker = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    setIsBusy(true);
    try {
      await fetch(serverUrl('/thinker/trigger'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, reason: 'manual_control_panel' }),
      });
      addEvent('System', 'Manual thinker trigger sent.');
      await refreshDashboard();
    } finally {
      setIsBusy(false);
    }
  }, [addEvent, refreshDashboard, sessionId]);

  const { isRecording, interimResults, startRecording, stopRecording } = useFluxSTT(sendUtterance);

  // -- derived data ---------------------------------------------------------

  const isSessionActive = status?.active ?? false;

  const talkerStatusDot = useMemo(() => {
    switch (status?.talkerStatus) {
      case 'active': return 'status-dot-active';
      case 'waiting': return 'status-dot-waiting';
      default: return 'status-dot-idle';
    }
  }, [status?.talkerStatus]);

  const thinkerStatusDot = useMemo(() => {
    switch (status?.thinkerStatus) {
      case 'running': return 'status-dot-running';
      case 'scheduled': return 'status-dot-active';
      default: return 'status-dot-idle';
    }
  }, [status?.thinkerStatus]);

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <main className="h-screen flex flex-col scanline" style={{ overflow: 'hidden' }}>

      {/* ── HEADER BAR ─────────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--panel)] flex-shrink-0">
        {/* title */}
        <div className="flex items-center gap-2 mr-2">
          <Terminal size={13} className="text-[var(--accent)]" />
          <span className="font-bold text-[var(--text)] text-[13px] uppercase tracking-wider">Ariadne</span>
        </div>

        {/* status badges */}
        <div className="flex items-center gap-3 text-[10px] uppercase mr-auto">
          <span className="flex items-center gap-1.5">
            <span className={`status-dot ${talkerStatusDot}`} />
            <Radio size={10} className="text-[var(--accent)]" />
            <span className="text-[var(--muted)]">Talker</span>
            <span className="text-[var(--text)]">{status?.talkerStatus ?? 'idle'}</span>
          </span>

          <span className="text-[var(--border)]">│</span>

          <span className="flex items-center gap-1.5">
            <span className={`status-dot ${thinkerStatusDot}`} />
            <BrainCircuit size={10} className="text-[var(--accent-warm)]" />
            <span className="text-[var(--muted)]">Thinker</span>
            <span className="text-[var(--text)]">{status?.thinkerStatus ?? 'idle'}</span>
          </span>

          <span className="text-[var(--border)]">│</span>

          <span className="flex items-center gap-1.5">
            <Activity size={10} className="text-[var(--ok)]" />
            <span className="text-[var(--text)]">{status?.connectedClients ?? 0}</span>
            <span className="text-[var(--muted)]">users</span>
          </span>

          <span className="text-[var(--border)]">│</span>

          <span className="flex items-center gap-1.5">
            <span className="text-[var(--muted)]">Session</span>
            <span className="text-[var(--text)] text-truncate" style={{ maxWidth: '100px' }}>{sessionId || '…'}</span>
          </span>

          <span className="text-[var(--border)]">│</span>

          <span className="text-[var(--muted)]">{DEFAULT_SERVER_URL.replace(/^https?:\/\//, '')}</span>
        </div>

        {/* session controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button className="btn btn-accent" onClick={() => void startSession()} disabled={isBusy}>
            <Power size={10} /> Start
          </button>
          <button className="btn btn-danger" onClick={() => void stopSession()} disabled={isBusy}>
            <Square size={10} /> Stop
          </button>
          <button className="btn" onClick={() => void triggerThinker()} disabled={isBusy || !isSessionActive}>
            <BrainCircuit size={10} /> Thinker
          </button>

          <span className="text-[var(--border)] mx-0.5">│</span>

          <button
            className={`btn ${isRecording ? 'btn-danger' : ''}`}
            onClick={isRecording ? stopRecording : () => { ensureAudioPipeline(); void startRecording(); }}
          >
            {isRecording ? <MicOff size={10} /> : <Mic size={10} />}
            {isRecording ? 'Mic Off' : 'Mic'}
          </button>
          <button
            className={`btn ${audioReady ? 'btn-ok' : ''}`}
            onClick={() => ensureAudioPipeline()}
          >
            {audioReady ? <Volume2 size={10} /> : <Play size={10} />}
            {audioReady ? 'Audio ✓' : 'Audio'}
          </button>
        </div>
      </header>

      {/* ── MAIN 3-COLUMN GRID ─────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)_340px]">

        {/* ── LEFT COLUMN: Session + Belief + Directives ───────────────── */}
        <div className="border-r border-[var(--border)] flex flex-col min-h-0 overflow-y-auto scroll-area">

          {/* session config */}
          <div className="p-2.5 border-b border-[var(--border)]">
            <div className="section-header">Session Config</div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="flex flex-col gap-1">
                <span className="text-[9px] text-[var(--muted)] uppercase">Mode</span>
                <select
                  value={interventionMode}
                  onChange={(event) => setInterventionMode(event.target.value as typeof interventionMode)}
                  className="input-field text-[10px]"
                >
                  <option value="control">Control</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[9px] text-[var(--muted)] uppercase">Thinker Interval</span>
                <select
                  value={thinkerIntervalSec}
                  onChange={(event) => setThinkerIntervalSec(Number(event.target.value))}
                  className="input-field text-[10px]"
                >
                  {INTERVAL_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}s</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* session status grid */}
          <div className="p-2.5 border-b border-[var(--border)]">
            <div className="section-header">Status</div>
            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
              <StatusCell label="Mode" value={status?.interventionMode ?? interventionMode} color="var(--accent-warm)" />
              <StatusCell label="Interval" value={`${status?.thinkerIntervalSec ?? thinkerIntervalSec}s`} />
              <StatusCell label="Last Thinker" value={status?.lastThinkerRunAt ? formatTime(status.lastThinkerRunAt) : 'N/A'} />
              <StatusCell label="Users" value={String(status?.connectedClients ?? 0)} color="var(--ok)" />
            </div>
          </div>

          {/* belief store */}
          <div className="p-2.5 border-b border-[var(--border)]">
            <div className="section-header">Belief Store</div>

            <div className="mb-2">
              <div className="text-[9px] text-[var(--muted)] uppercase mb-0.5">Topic</div>
              <div className="text-[var(--text)] text-[11px] text-truncate">{beliefStore?.discussion_state.currentTopic ?? 'NO TOPIC'}</div>
            </div>

            <div className="mb-2">
              <div className="text-[9px] text-[var(--muted)] uppercase mb-0.5">Phase</div>
              <div className="text-[var(--accent-warm)] text-[11px]">{beliefStore?.discussion_state.phase ?? 'UNKNOWN'}</div>
            </div>

            {(beliefStore?.discussion_state.openQuestions ?? []).length > 0 && (
              <div className="mb-2">
                <div className="text-[9px] text-[var(--muted)] uppercase mb-0.5">Open Questions</div>
                <div className="text-[10px] text-[var(--text)]">
                  {beliefStore?.discussion_state.openQuestions.map((question, index) => (
                    <div key={index} className="text-truncate">• {question}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-2">
              <div className="text-[9px] text-[var(--muted)] uppercase mb-0.5">Plan</div>
              {(beliefStore?.facilitation_plan ?? []).length > 0 ? (
                <div className="text-[10px] text-[var(--text)]">
                  {beliefStore?.facilitation_plan.map((item, index) => (
                    <div key={index} className="text-truncate">• {item}</div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-[var(--muted)]">No plan set</div>
              )}
            </div>

            <div>
              <div className="text-[9px] text-[var(--muted)] uppercase mb-0.5">Participants</div>
              {(beliefStore?.participants ?? []).length > 0 ? (
                <div className="flex flex-col gap-1">
                  {beliefStore?.participants.map((participant) => (
                    <div key={participant.id} className="flex items-center gap-2 text-[10px] bg-[var(--panel-strong)] px-2 py-1 border border-[var(--border)]">
                      <span className="text-[var(--accent)] font-bold text-truncate">{participant.id}</span>
                      <span className="text-[var(--muted)] text-truncate ml-auto">{participant.stance} · {participant.emotionalTone}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-[var(--muted)]">No participants</div>
              )}
            </div>
          </div>

          {/* directives */}
          <div className="p-2.5">
            <div className="section-header" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>Directives</div>

            <div className="mb-2">
              <div className="text-[9px] text-[var(--muted)] uppercase mb-1">Pending ({pendingDirectives.length})</div>
              {pendingDirectives.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)]">Empty</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {pendingDirectives.map((directive) => (
                    <div key={directive.id} className="border-l-2 border-[var(--accent-warm)] bg-[var(--panel-strong)] px-2 py-1 text-[10px]">
                      <div className="flex justify-between text-[9px] text-[var(--muted)] mb-0.5">
                        <span>{directive.priority}</span>
                        <span>{formatTime(directive.createdAt)}</span>
                      </div>
                      <div className="text-[var(--text)]">{directive.instruction}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-[9px] text-[var(--muted)] uppercase mb-1">Fulfilled ({fulfilledDirectives.length})</div>
              {fulfilledDirectives.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)]">Empty</div>
              ) : (
                <div className="flex flex-col gap-1 opacity-50">
                  {fulfilledDirectives.map((directive) => (
                    <div key={directive.id} className="border-l-2 border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[10px] text-[var(--muted)]">
                      {directive.instruction}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── CENTRE COLUMN: Conversation Feed ─────────────────────────── */}
        <div className="flex flex-col min-h-0 min-w-0 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-[var(--border)] flex-shrink-0">
            <span className="section-header" style={{ border: 'none', margin: 0, padding: 0 }}>
              Conversation ({messages.length})
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scroll-area px-3 py-2 flex flex-col gap-1.5">
            {messages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-[var(--muted)] text-[11px] border border-dashed border-[var(--border)]" style={{ minHeight: '80px' }}>
                No messages yet
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* interim STT results */}
          {interimResults.size > 0 && (
            <div className="px-3 py-1 border-t border-[var(--accent-warm)] bg-[var(--panel-strong)] text-[10px] text-[var(--accent-warm)] flex-shrink-0">
              {Array.from(interimResults.entries()).map(([speaker, text]) => (
                <div key={speaker} className="text-truncate">[{speaker}]: {text}</div>
              ))}
            </div>
          )}

          {/* input bar */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-[var(--border)] bg-[var(--panel)] flex-shrink-0">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void sendUtterance(input);
              }}
              placeholder="Type a message..."
              className="input-field flex-1"
            />
            <button className="btn btn-accent" onClick={() => void sendUtterance(input)}>
              <Send size={10} /> Send
            </button>
          </div>
        </div>

        {/* ── RIGHT COLUMN: Agent Activity + Event Log ─────────────────── */}
        <div className="border-l border-[var(--border)] flex flex-col min-h-0">

          {/* agent activity feed */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 py-1.5 border-b border-[var(--border)] flex-shrink-0">
              <span className="section-header" style={{ border: 'none', margin: 0, padding: 0 }}>
                Agent Activity ({activity.length})
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto scroll-area px-2 py-1.5 flex flex-col gap-1">
              {activity.length === 0 ? (
                <div className="flex items-center justify-center text-[var(--muted)] text-[10px] border border-dashed border-[var(--border)] py-4">
                  No agent activity yet
                </div>
              ) : (
                activity.map((entry) => (
                  <ActivityEntry key={entry.id} entry={entry} />
                ))
              )}
              <div ref={activityEndRef} />
            </div>
          </div>

          {/* raw event log */}
          <div className="flex flex-col border-t border-[var(--border)]" style={{ height: '180px', flexShrink: 0 }}>
            <div className="px-3 py-1 border-b border-[var(--border)] flex-shrink-0">
              <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Event Log ({events.length})
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto scroll-area px-2 py-1 flex flex-col gap-0.5 text-[9px]">
              {events.map((systemEvent) => (
                <div key={systemEvent.id} className="flex gap-2 leading-tight py-0.5">
                  <span className="text-[var(--accent)] flex-shrink-0 uppercase" style={{ width: '50px' }}>
                    {formatTime(systemEvent.timestamp).slice(-8)}
                  </span>
                  <span className="text-[var(--muted)] flex-shrink-0 uppercase text-truncate" style={{ width: '90px' }}>
                    {systemEvent.type}
                  </span>
                  <span className="text-[var(--text)] text-truncate flex-1 break-all">
                    {truncateText(systemEvent.details, 120)}
                  </span>
                </div>
              ))}
              <div ref={eventsEndRef} />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ===========================================================================
// SUB-COMPONENTS
// ===========================================================================

function StatusCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[var(--bg)] border border-[var(--border)] px-2 py-1.5">
      <div className="text-[9px] text-[var(--muted)] uppercase mb-0.5">{label}</div>
      <div className="text-[11px] font-bold text-truncate" style={{ color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isAssistant = message.role === 'assistant';
  const isUser = message.role === 'user';
  const isThinker = message.speakerId === 'thinker';

  const toolCallNames = message.toolCalls?.map((toolCall) => toolCall.function.name) ?? [];

  return (
    <article
      className={`border px-2.5 py-2 text-[11px] ${
        isThinker
          ? 'border-[var(--accent-warm)] bg-[rgba(255,170,0,0.06)] ml-6'
          : isAssistant
            ? 'border-[var(--accent)] bg-[rgba(255,71,15,0.04)] ml-6'
            : isUser
              ? 'border-[var(--border)] bg-[var(--panel-strong)] mr-6'
              : 'border-[var(--border)]'
      }`}
    >
      <div className="flex items-center gap-2 text-[9px] uppercase font-bold text-[var(--muted)] mb-1">
        <span className={isThinker ? 'text-[var(--accent-warm)]' : isAssistant ? 'text-[var(--accent)]' : isUser ? 'text-[var(--text)]' : 'text-[var(--muted)]'}>
          {isThinker ? 'thinker' : message.role}
        </span>
        {toolCallNames.length > 0 && (
          <span className="flex items-center gap-1 ml-auto">
            {toolCallNames.map((name, index) => (
              <span key={index} className="text-[8px] px-1 py-px border border-[var(--ok)] text-[var(--ok)] uppercase">
                {name}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="text-[var(--text)] leading-relaxed whitespace-pre-wrap break-words">
        {message.content || '[NO CONTENT]'}
      </div>
    </article>
  );
}

function ActivityEntry({ entry }: { entry: AgentActivityEntry }) {
  const time = formatTime(entry.timestamp);

  switch (entry.kind) {
    case 'talker-output':
      return (
        <div className="border border-[var(--border)] bg-[var(--panel)] p-1.5">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="badge badge-talker">
              <Radio size={8} /> Talker
            </span>
            <span className="text-[9px] text-[var(--muted)] ml-auto">{time}</span>
          </div>

          {entry.toolCalls && entry.toolCalls.length > 0 && (
            <div className="flex flex-col gap-0.5 mb-1">
              {entry.toolCalls.map((toolCall, index) => (
                <div key={index} className="text-[10px] flex items-center gap-1">
                  <span className="text-[var(--ok)]">→</span>
                  <span className="text-[var(--ok)] font-bold">{toolCall.name}</span>
                  <span className="text-[var(--muted)] text-truncate flex-1">{truncateText(toolCall.args, 60)}</span>
                </div>
              ))}
            </div>
          )}

          {entry.spokenText && (
            <div className="text-[10px] text-[var(--text)] leading-snug mt-0.5">
              &ldquo;{truncateText(entry.spokenText, 150)}&rdquo;
            </div>
          )}
        </div>
      );

    case 'thinker-complete':
      return (
        <div className="border border-[var(--border)] bg-[var(--panel)] p-1.5">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="badge badge-thinker">
              <BrainCircuit size={8} /> Thinker
            </span>
            <span className="text-[10px] text-[var(--text)]">
              {entry.directiveCount} directive{entry.directiveCount !== 1 ? 's' : ''}
            </span>
            <span className="text-[9px] text-[var(--muted)] ml-auto">{time}</span>
          </div>

          {entry.toolCalls && entry.toolCalls.length > 0 && (
            <div className="flex flex-col gap-0.5 mb-1">
              {entry.toolCalls.map((toolCall, index) => (
                <div key={index} className="text-[10px] flex items-center gap-1">
                  <span className="text-[var(--ok)]">→</span>
                  <span className="text-[var(--ok)] font-bold">{toolCall.name}</span>
                  <span className="text-[var(--muted)] text-truncate flex-1">{truncateText(toolCall.args, 60)}</span>
                </div>
              ))}
            </div>
          )}

          {entry.reasoning && (
            <div className="text-[10px] text-[var(--text)] leading-snug mt-0.5 whitespace-pre-wrap">
              {truncateText(entry.reasoning, 300)}
            </div>
          )}

          <div className="text-[9px] text-[var(--muted)] mt-0.5">
            Trigger: {entry.reason}
          </div>
        </div>
      );

    case 'tool-call':
      return (
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10px]">
          <span className="badge badge-tool">
            {entry.agent === 'thinker' ? <BrainCircuit size={7} /> : <Radio size={7} />}
            Tool
          </span>
          <span className="text-[var(--ok)] font-bold">{entry.name}</span>
          <span className="text-[var(--muted)] text-truncate flex-1">{truncateText(entry.args, 50)}</span>
          <span className="text-[9px] text-[var(--muted)] flex-shrink-0">{time}</span>
        </div>
      );

    case 'telemetry':
      return (
        <div className="flex items-center gap-1.5 px-1.5 py-0.5 text-[10px]">
          <span className="badge badge-system">SYS</span>
          <span className="text-[var(--muted)] text-truncate flex-1">{entry.type}: {truncateText(entry.summary, 60)}</span>
          <span className="text-[9px] text-[var(--muted)] flex-shrink-0">{time}</span>
        </div>
      );

    default:
      return null;
  }
}

// -- telemetry summariser ---------------------------------------------------

function summariseTelemetry(payload: Record<string, unknown>): string {
  const type = String(payload.type ?? '');

  if (type === 'talker.fallback_speak') {
    return `Fallback speak, ${payload.textLength ?? '?'} chars`;
  }

  if (type === 'reasoner.trigger_talker') {
    return `Triggered talker, ${payload.directiveCount ?? 0} directives`;
  }

  if (type === 'reasoner.skip_talker_stale_directives') {
    return `Skipped stale directives (${payload.directiveCount ?? 0})`;
  }

  // generic fallback — pick out a few useful fields
  const useful = Object.entries(payload)
    .filter(([key]) => key !== 'type' && key !== 'sessionId' && key !== 'eventId')
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');

  return useful || type;
}
