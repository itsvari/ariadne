"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BrainCircuit, Mic, MicOff, Play, Power, Radio, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { BeliefStore } from '@ariadne/shared-contracts';
import { useFluxSTT } from '../hooks/useFluxSTT';
import { DEFAULT_SERVER_URL, eventSocketUrl, serverUrl } from '../lib/server';
import type { DashboardState, Message, SessionEvent, SessionStatusView, SystemEvent } from '../lib/types';

function cn(...parts: Array<string | false | null | undefined>) {
  return twMerge(clsx(parts));
}

const SESSION_ID_STORAGE_KEY = 'ariadne-session-id';

const INTERVAL_OPTIONS = [30, 60, 120];

export default function AriadneControlPanel() {
  const [sessionId, setSessionId] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [status, setStatus] = useState<SessionStatusView | null>(null);
  const [beliefStore, setBeliefStore] = useState<BeliefStore | null>(null);
  const [pendingDirectives, setPendingDirectives] = useState<DashboardState['directives']['pending']>([]);
  const [fulfilledDirectives, setFulfilledDirectives] = useState<DashboardState['directives']['fulfilled']>([]);
  const [interventionMode, setInterventionMode] = useState<'control' | 'light' | 'heavy'>('light');
  const [thinkerIntervalSec, setThinkerIntervalSec] = useState(60);
  const [isBusy, setIsBusy] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const eventsEndRef = useRef<HTMLDivElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioQueueRef = useRef<Uint8Array[]>([]);
  const isAppendingRef = useRef(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_ID_STORAGE_KEY) ?? `session-${crypto.randomUUID()}`;
    setSessionId(saved);
    window.localStorage.setItem(SESSION_ID_STORAGE_KEY, saved);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const addEvent = useCallback((type: string, details: string) => {
    setEvents((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type,
        details,
      },
    ]);
  }, []);

  const flushAudioQueue = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    const mediaSource = mediaSourceRef.current;
    if (!sourceBuffer || !mediaSource || sourceBuffer.updating || isAppendingRef.current) {
      return;
    }

    const nextChunk = audioQueueRef.current.shift();
    if (!nextChunk) {
      return;
    }

    isAppendingRef.current = true;
    const chunk = nextChunk.slice();
    sourceBuffer.appendBuffer(chunk);
  }, []);

  const ensureAudioPipeline = useCallback(() => {
    if (audioRef.current && mediaSourceRef.current && sourceBufferRef.current) {
      return;
    }

    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;

    const audio = new Audio(URL.createObjectURL(mediaSource));
    audioRef.current = audio;

    mediaSource.addEventListener('sourceopen', () => {
      if (sourceBufferRef.current) {
        return;
      }

      const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
      sourceBuffer.mode = 'sequence';
      sourceBufferRef.current = sourceBuffer;
      sourceBuffer.addEventListener('updateend', () => {
        isAppendingRef.current = false;
        flushAudioQueue();
      });
      setAudioReady(true);
      void audio.play().catch(() => {
        // Browser autoplay rules may delay playback until user interaction.
      });
      flushAudioQueue();
    });
  }, [flushAudioQueue]);

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
        const statusPayload = (await statusResponse.json()) as {
          status: SessionStatusView;
        };
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

  const handleSessionEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case 'session.status':
          setStatus(event.payload as SessionStatusView);
          break;
        case 'utterance.final': {
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
          break;
        }
        case 'talker.output': {
          const payload = event.payload as { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
          const speakCall = payload.tool_calls?.find((toolCall) => toolCall.function.name === 'speak');
          const spokenText = speakCall
            ? ((JSON.parse(speakCall.function.arguments) as { text?: string }).text ?? '')
            : payload.content ?? '';
          const normalizedToolCalls = payload.tool_calls?.map((toolCall) => ({
            type: 'function' as const,
            function: toolCall.function,
          }));

          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: spokenText,
              reasoning: payload.content ?? undefined,
              toolCalls: normalizedToolCalls,
            },
          ]);

          if (spokenText) {
            addEvent('TalkerResponse', spokenText);
          }
          break;
        }
        case 'avatar.command':
          addEvent('AvatarCommand', JSON.stringify(event.payload));
          break;
        case 'reasoner.complete':
          addEvent('ReasonerComplete', JSON.stringify(event.payload));
          void refreshDashboard();
          break;
        case 'telemetry':
          addEvent('Telemetry', JSON.stringify(event.payload));
          break;
        case 'speak':
          addEvent('Speak', String((event.payload as { text?: string }).text ?? ''));
          break;
        case 'tts.audio.chunk': {
          ensureAudioPipeline();
          const payload = event.payload as { audioBase64: string };
          audioQueueRef.current.push(Uint8Array.from(atob(payload.audioBase64), (char) => char.charCodeAt(0)));
          flushAudioQueue();
          break;
        }
        case 'tts.audio.done':
          addEvent('TTS', `Audio stream complete (${JSON.stringify(event.payload)})`);
          break;
        default:
          addEvent(event.type, JSON.stringify(event.payload));
      }
    },
    [addEvent, ensureAudioPipeline, flushAudioQueue, refreshDashboard],
  );

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

    return () => {
      socket.close();
    };
  }, [handleSessionEvent, refreshDashboard, sessionId]);

  useEffect(() => {
    if (!status?.active) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshDashboard();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [refreshDashboard, status?.active]);

  const startSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

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
      const payload = (await response.json()) as SessionStatusView;
      setStatus(payload);
      addEvent('System', `Session started against ${DEFAULT_SERVER_URL}`);
      await refreshDashboard();
    } finally {
      setIsBusy(false);
    }
  }, [addEvent, interventionMode, refreshDashboard, sessionId, thinkerIntervalSec]);

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
      const payload = (await response.json()) as SessionStatusView;
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

      await fetch(serverUrl('/utterance'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, text: text.trim(), speakerId }),
      });
      setInput('');
    },
    [sessionId],
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

  const stats = useMemo(
    () => [
      {
        label: 'Talker',
        value: status?.talkerStatus ?? 'idle',
        icon: Radio,
      },
      {
        label: 'Thinker',
        value: status?.thinkerStatus ?? 'idle',
        icon: BrainCircuit,
      },
      {
        label: 'Participants',
        value: String(beliefStore?.participants.length ?? 0),
        icon: Activity,
      },
    ],
    [beliefStore?.participants.length, status?.talkerStatus, status?.thinkerStatus],
  );

  return (
    <main className="min-h-screen px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <section className="panel scanline rounded-[28px] px-6 py-6 md:px-8 md:py-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-4">
              <div className="mono inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1 text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">
                <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
                Ariadne Control Panel
              </div>
              <div className="space-y-3">
                <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-white md:text-6xl">
                  Run the talker-thinker loop without losing sight of the room.
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-[var(--muted)] md:text-base">
                  Live speech capture, thinker scheduling, belief tracking, and directive visibility in one orchestration console.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {stats.map((stat) => {
                const Icon = stat.icon;
                return (
                  <div key={stat.label} className="rounded-2xl border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-4">
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.28em] text-[var(--muted)]">
                      <span>{stat.label}</span>
                      <Icon className="h-4 w-4 text-[var(--accent)]" />
                    </div>
                    <div className="mt-3 mono text-xl font-semibold text-white">{stat.value}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.35fr_0.95fr]">
          <div className="flex flex-col gap-6">
            <section className="panel rounded-[24px] p-5 md:p-6">
              <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="mono text-[11px] uppercase tracking-[0.3em] text-[var(--muted)]">Session Controls</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">Realtime orchestration</h2>
                </div>
                <p className="mono text-xs text-[var(--muted)]">Session ID: {sessionId || 'initializing...'}</p>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-2">
                  <span className="mono text-[11px] uppercase tracking-[0.26em] text-[var(--muted)]">Intervention</span>
                  <select
                    value={interventionMode}
                    onChange={(event) => setInterventionMode(event.target.value as typeof interventionMode)}
                    className="w-full rounded-2xl border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-3 text-sm text-white outline-none"
                  >
                    <option value="control">Control</option>
                    <option value="light">Light</option>
                    <option value="heavy">Heavy</option>
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="mono text-[11px] uppercase tracking-[0.26em] text-[var(--muted)]">Thinker Interval</span>
                  <select
                    value={thinkerIntervalSec}
                    onChange={(event) => setThinkerIntervalSec(Number(event.target.value))}
                    className="w-full rounded-2xl border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-3 text-sm text-white outline-none"
                  >
                    {INTERVAL_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}s
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2 md:col-span-2 xl:col-span-1">
                  <span className="mono text-[11px] uppercase tracking-[0.26em] text-[var(--muted)]">Manual Utterance</span>
                  <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void sendUtterance(input);
                      }
                    }}
                    placeholder="Type something Ariadne should hear"
                    className="w-full rounded-2xl border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-3 text-sm text-white outline-none placeholder:text-[var(--muted)]"
                  />
                </label>

                <div className="grid gap-2 md:col-span-2 xl:col-span-1">
                  <button
                    onClick={() => void startSession()}
                    disabled={isBusy}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                  >
                    <Power className="h-4 w-4" />
                    Start / Apply
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => void stopSession()}
                      disabled={isBusy}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-3 text-sm text-white transition hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:opacity-60"
                    >
                      Stop
                    </button>
                    <button
                      onClick={() => void triggerThinker()}
                      disabled={isBusy || !status?.active}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-3 text-sm text-white transition hover:border-[var(--accent-warm)] hover:text-[var(--accent-warm)] disabled:opacity-60"
                    >
                      <BrainCircuit className="h-4 w-4" />
                      Trigger
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  onClick={isRecording ? stopRecording : () => void startRecording()}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition',
                    isRecording
                      ? 'bg-[var(--danger)] text-slate-950 hover:brightness-110'
                      : 'border border-[var(--border)] bg-[var(--panel-strong)] text-white hover:border-[var(--accent)] hover:text-[var(--accent)]',
                  )}
                >
                  {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  {isRecording ? 'Stop microphone' : 'Start microphone'}
                </button>
                <button
                  onClick={() => ensureAudioPipeline()}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel-strong)] px-5 py-3 text-sm text-white transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  <Play className="h-4 w-4" />
                  {audioReady ? 'Audio ready' : 'Prime audio'}
                </button>
                {interimResults.size > 0 && (
                  <span className="mono text-xs text-[var(--accent-warm)]">
                    {Array.from(interimResults.entries()).map(([speaker, text]) => (
                      <span key={speaker} className="mr-3">[{speaker}]: {text}</span>
                    ))}
                  </span>
                )}
              </div>
            </section>

            <section className="panel rounded-[24px] p-5 md:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="mono text-[11px] uppercase tracking-[0.3em] text-[var(--muted)]">Conversation Feed</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">Live transcript and model actions</h2>
                </div>
              </div>

              <div className="mt-6 space-y-4 overflow-y-auto pr-2" style={{ maxHeight: '38rem' }}>
                {messages.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-[var(--border)] px-5 py-8 text-center text-sm text-[var(--muted)]">
                    Start a session, then speak or type an utterance to see the talker-thinker loop unfold.
                  </div>
                ) : (
                  messages.map((message) => (
                    <article
                      key={message.id}
                      className={cn(
                        'rounded-3xl border px-5 py-4',
                        message.role === 'assistant'
                          ? 'border-[rgba(112,214,193,0.22)] bg-[rgba(10,30,40,0.72)]'
                          : message.role === 'user'
                            ? 'border-[rgba(241,191,122,0.22)] bg-[rgba(40,26,11,0.36)]'
                            : 'border-[var(--border)] bg-[var(--panel-strong)]',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="mono text-[11px] uppercase tracking-[0.3em] text-[var(--muted)]">
                          {message.role}
                          {message.speakerId ? ` / ${message.speakerId}` : ''}
                        </span>
                      </div>
                      {message.reasoning && (
                        <p className="mono mt-3 rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-3 py-2 text-xs leading-6 text-[var(--muted)]">
                          {message.reasoning}
                        </p>
                      )}
                      {message.toolCalls?.length ? (
                        <div className="mt-3 space-y-2">
                          {message.toolCalls.map((toolCall, index) => (
                            <pre
                              key={`${message.id}-${index}`}
                              className="mono overflow-x-auto rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-3 py-2 text-xs text-[var(--accent)]"
                            >
                              {toolCall.function.name}: {toolCall.function.arguments}
                            </pre>
                          ))}
                        </div>
                      ) : null}
                      <p className="mt-3 text-sm leading-7 text-white/90">{message.content || 'No direct text output.'}</p>
                    </article>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
            </section>
          </div>

          <div className="flex flex-col gap-6">
            <section className="panel rounded-[24px] p-5 md:p-6">
              <div>
                <p className="mono text-[11px] uppercase tracking-[0.3em] text-[var(--muted)]">Session Status</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Talker-thinker heartbeat</h2>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <MetricCard label="Server" value={DEFAULT_SERVER_URL.replace(/^https?:\/\//, '')} tone="accent" />
                <MetricCard label="Mode" value={status?.interventionMode ?? interventionMode} tone="warm" />
                <MetricCard label="Thinker Interval" value={`${status?.thinkerIntervalSec ?? thinkerIntervalSec}s`} tone="neutral" />
                <MetricCard label="Last Thinker Run" value={status?.lastThinkerRunAt ? new Date(status.lastThinkerRunAt).toLocaleTimeString() : 'Not yet'} tone="neutral" />
              </div>
            </section>

            <section className="panel rounded-[24px] p-5 md:p-6">
              <div>
                <p className="mono text-[11px] uppercase tracking-[0.3em] text-[var(--muted)]">Belief Store</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Strategic memory snapshot</h2>
              </div>

              <div className="mt-5 space-y-4 text-sm text-[var(--muted)]">
                <div className="rounded-3xl border border-[var(--border)] bg-[var(--panel-strong)] p-4">
                  <p className="mono text-[11px] uppercase tracking-[0.26em]">Discussion State</p>
                  <p className="mt-3 text-white">{beliefStore?.discussion_state.currentTopic ?? 'No topic yet'}</p>
                  <p className="mt-2">Phase: {beliefStore?.discussion_state.phase ?? 'Unknown'}</p>
                  <p className="mt-2">Open questions: {(beliefStore?.discussion_state.openQuestions ?? []).join(', ') || 'None recorded'}</p>
                </div>

                <div className="rounded-3xl border border-[var(--border)] bg-[var(--panel-strong)] p-4">
                  <p className="mono text-[11px] uppercase tracking-[0.26em]">Facilitation Plan</p>
                  <ul className="mt-3 space-y-2 text-white">
                    {(beliefStore?.facilitation_plan ?? []).length ? (
                      beliefStore?.facilitation_plan.map((item) => <li key={item}>- {item}</li>)
                    ) : (
                      <li>- Thinker has not written a plan yet.</li>
                    )}
                  </ul>
                </div>

                <div className="rounded-3xl border border-[var(--border)] bg-[var(--panel-strong)] p-4">
                  <p className="mono text-[11px] uppercase tracking-[0.26em]">Participants</p>
                  <div className="mt-3 space-y-3">
                    {(beliefStore?.participants ?? []).length ? (
                      beliefStore?.participants.map((participant) => (
                        <div key={participant.id} className="rounded-2xl border border-[var(--border)] px-3 py-3 text-white">
                          <div className="mono text-xs text-[var(--accent)]">{participant.id}</div>
                          <div className="mt-2 text-sm text-[var(--muted)]">
                            stance: {participant.stance} / tone: {participant.emotionalTone} / engagement: {participant.engagementLevel}
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-white">No participants modeled yet.</p>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="panel rounded-[24px] p-5 md:p-6">
              <div>
                <p className="mono text-[11px] uppercase tracking-[0.3em] text-[var(--muted)]">Directive Queue</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Pending and fulfilled prompts</h2>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <DirectiveList title="Pending" items={pendingDirectives} empty="No pending directives." />
                <DirectiveList title="Fulfilled" items={fulfilledDirectives} empty="No fulfilled directives yet." />
              </div>
            </section>

            <section className="panel rounded-[24px] p-5 md:p-6">
              <div>
                <p className="mono text-[11px] uppercase tracking-[0.3em] text-[var(--muted)]">System Events</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Operational log</h2>
              </div>

              <div className="mt-5 space-y-2 overflow-y-auto pr-1" style={{ maxHeight: '24rem' }}>
                {events.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-[var(--border)] px-5 py-8 text-center text-sm text-[var(--muted)]">
                    Events will stream here once the session is active.
                  </div>
                ) : (
                  events.map((event) => (
                    <div key={event.id} className="rounded-2xl border border-[var(--border)] bg-[var(--panel-strong)] px-4 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <span className="mono text-[11px] uppercase tracking-[0.26em] text-[var(--accent)]">{event.type}</span>
                        <span className="mono text-[11px] text-[var(--muted)]">{new Date(event.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-white/85">{event.details}</p>
                    </div>
                  ))
                )}
                <div ref={eventsEndRef} />
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: 'accent' | 'warm' | 'neutral' }) {
  return (
    <div
      className={cn(
        'rounded-3xl border px-4 py-4',
        tone === 'accent'
          ? 'border-[rgba(112,214,193,0.26)] bg-[rgba(9,28,33,0.92)]'
          : tone === 'warm'
            ? 'border-[rgba(241,191,122,0.26)] bg-[rgba(37,28,16,0.78)]'
            : 'border-[var(--border)] bg-[var(--panel-strong)]',
      )}
    >
      <p className="mono text-[11px] uppercase tracking-[0.26em] text-[var(--muted)]">{label}</p>
      <p className="mt-3 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function DirectiveList({
  title,
  items,
  empty,
}: {
  title: string;
  items: Array<{ id: string; instruction: string; priority: string; createdAt: string }>;
  empty: string;
}) {
  return (
    <div className="rounded-3xl border border-[var(--border)] bg-[var(--panel-strong)] p-4">
      <p className="mono text-[11px] uppercase tracking-[0.26em] text-[var(--muted)]">{title}</p>
      <div className="mt-3 space-y-3">
        {items.length ? (
          items.map((item) => (
            <div key={item.id} className="rounded-2xl border border-[var(--border)] px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="mono text-xs text-[var(--accent)]">{item.priority}</span>
                <span className="mono text-[11px] text-[var(--muted)]">{new Date(item.createdAt).toLocaleTimeString()}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-white">{item.instruction}</p>
            </div>
          ))
        ) : (
          <p className="text-sm text-white/80">{empty}</p>
        )}
      </div>
    </div>
  );
}
