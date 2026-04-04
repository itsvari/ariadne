"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BrainCircuit, Mic, MicOff, Play, Power, Radio, Sparkles, Terminal } from 'lucide-react';
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
  
  // Local state for dropdowns
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

  const resumeAudioPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    void audio.play().catch((err) => {
      console.warn('Browser autoplay blocked:', err);
    });
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_ID_STORAGE_KEY) ?? `session-${crypto.randomUUID()}`;
    setSessionId(saved);
  }, []);

  // Fix: Track session status from backend
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

  useEffect(() => {
    // Fix: layout shifts. Use smooth scroll ONLY if within a bounded area, or auto to prevent page jump
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [messages]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
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
    if (!sourceBuffer || sourceBuffer.updating || isAppendingRef.current) {
      return;
    }

    const nextChunk = audioQueueRef.current.shift();
    if (!nextChunk) {
      return;
    }

    isAppendingRef.current = true;
    const chunk = nextChunk.slice();
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      console.error("Failed to append buffer", e);
      isAppendingRef.current = false;
    }
  }, []);

  // Fix: Audio context synchronously bound to user interaction
  const ensureAudioPipeline = useCallback(() => {
    if (audioRef.current && mediaSourceRef.current && sourceBufferRef.current) {
      resumeAudioPlayback();
      return;
    }

    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;

    const audio = new Audio(URL.createObjectURL(mediaSource));
    audioRef.current = audio;

    // Start (or resume) playback as soon as the element exists.
    resumeAudioPlayback();

    mediaSource.addEventListener('sourceopen', () => {
      if (sourceBufferRef.current) {
        return;
      }

      if (!MediaSource.isTypeSupported('audio/mpeg')) {
        addEvent('TTS', 'Browser does not support MediaSource audio/mpeg playback.');
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
      resumeAudioPlayback();
      flushAudioQueue();
    });
  }, [addEvent, flushAudioQueue, resumeAudioPlayback]);

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
          resumeAudioPlayback();
          flushAudioQueue();
          break;
        }
        case 'tts.audio.done':
          addEvent('TTS', `Audio stream complete.`);
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
      const payload = (await response.json()) as SessionStatusView;
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

  // Stats mapped for UI
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
        label: 'Users',
        value: String(beliefStore?.participants.length ?? 0),
        icon: Activity,
      },
    ],
    [beliefStore?.participants.length, status?.talkerStatus, status?.thinkerStatus],
  );

  return (
    <main className="min-h-screen p-4 md:p-8 flex flex-col gap-8 max-w-7xl mx-auto scanline">
      {/* Header section */}
      <header className="panel p-6 border-b-4 border-b-[var(--accent)] flex flex-col lg:flex-row gap-6 justify-between items-start lg:items-end">
        <div className="space-y-4 max-w-2xl">
          <div className="mono inline-flex items-center gap-2 bg-[var(--text)] text-[var(--bg)] px-3 py-1 text-xs font-bold uppercase tracking-widest">
            <Terminal size={14} />
            System Control
          </div>
          <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tight text-white leading-none">
            Ariadne <span className="text-[var(--accent)]">Control Panel</span>
          </h1>
          <p className="text-[var(--muted)] font-mono text-sm leading-relaxed border-l-2 border-[var(--border)] pl-4">
            Live speech capture, thinker scheduling, belief tracking, and directive visibility in one console.
          </p>
        </div>
        
        <div className="flex gap-4 w-full lg:w-auto">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="panel p-4 flex-1 lg:flex-none lg:w-32">
                <div className="flex items-center justify-between text-[var(--muted)] mb-3">
                  <Icon size={16} />
                </div>
                <div className="mono text-2xl font-bold uppercase">{stat.value}</div>
                <div className="font-mono text-[10px] uppercase text-[var(--muted)] mt-1">{stat.label}</div>
              </div>
            );
          })}
        </div>
      </header>

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column (Main Feed & Interactions) */}
        <div className="lg:col-span-7 flex flex-col gap-8">
          
          <section className="panel p-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 border-b border-[var(--border)] pb-4 mb-6">
              <div>
                <h2 className="text-2xl font-bold uppercase">Session Controls</h2>
              </div>
              <div className="mono text-xs bg-[var(--panel-strong)] px-3 py-1 border border-[var(--border)]">
                ID: {sessionId || 'WAITING...'}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 place-items-stretch">
              <label className="flex flex-col gap-2">
                <span className="mono text-xs text-[var(--muted)] uppercase font-bold tracking-widest">Intervention Mode</span>
                <select
                  value={interventionMode}
                  onChange={(event) => setInterventionMode(event.target.value as typeof interventionMode)}
                  className="bg-[var(--bg)] border-2 border-[var(--border)] px-4 py-3 outline-none text-white focus:border-[var(--accent)] font-mono text-sm"
                >
                  <option value="control">Control (Manual)</option>
                  <option value="light">Light (Supervised)</option>
                  <option value="heavy">Heavy (Autonomous)</option>
                </select>
              </label>

              <label className="flex flex-col gap-2">
                <span className="mono text-xs text-[var(--muted)] uppercase font-bold tracking-widest">Thinker Interval</span>
                <select
                  value={thinkerIntervalSec}
                  onChange={(event) => setThinkerIntervalSec(Number(event.target.value))}
                  className="bg-[var(--bg)] border-2 border-[var(--border)] px-4 py-3 outline-none text-white focus:border-[var(--accent)] font-mono text-sm"
                >
                  {INTERVAL_OPTIONS.map((o) => (
                    <option key={o} value={o}>{o}s INTERVAL</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-6 flex flex-col sm:flex-row gap-4">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void sendUtterance(input);
                }}
                placeholder="Type something..."
                className="flex-1 bg-[var(--bg)] border-2 border-[var(--border)] px-4 py-3 focus:border-[var(--accent)] font-mono outline-none placeholder-[var(--muted)]"
              />
              <button 
                className="btn-brutal"
                onClick={() => void sendUtterance(input)}
              >
                Send
              </button>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-4 bg-[var(--bg)] p-4 border border-[var(--border)]">
              <button onClick={() => void startSession()} disabled={isBusy} className="btn-brutal btn-accent">
                <Power size={16} /> Start
              </button>
              <button onClick={() => void stopSession()} disabled={isBusy} className="btn-brutal text-[var(--danger)] hover:border-[var(--danger)] hover:text-[var(--danger)]">
                Stop
              </button>
              <button onClick={() => void triggerThinker()} disabled={isBusy || !status?.active} className="btn-brutal">
                <BrainCircuit size={16} /> Trigger Thinker
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-4 border-t border-[var(--border)] pt-4">
              <button
                onClick={isRecording ? stopRecording : () => {
                  ensureAudioPipeline();
                  void startRecording();
                }}
                className={cn('btn-brutal', isRecording && 'border-[var(--danger)] text-[var(--danger)]')}
              >
                {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
                {isRecording ? 'Stop Microphone' : 'Start Microphone'}
              </button>
              <button
                onClick={() => ensureAudioPipeline()}
                className={cn('btn-brutal', audioReady && 'border-[var(--accent)] text-[var(--accent)]')}
              >
                <Play size={16} />
                {audioReady ? 'Audio Ready' : 'Prime Audio'}
              </button>
            </div>
            
            {interimResults.size > 0 && (
              <div className="mt-4 bg-[var(--panel-strong)] p-3 border-l-4 border-[var(--accent-warm)] font-mono text-sm text-[var(--accent-warm)]">
                {Array.from(interimResults.entries()).map(([speaker, text]) => (
                  <div key={speaker}>[{speaker}]: {text}</div>
                ))}
              </div>
            )}
          </section>

          <section className="panel p-6 flex flex-col flex-1 relative">
            <h2 className="text-2xl font-bold uppercase mb-4 sticky top-0 bg-[var(--panel)] z-10 pb-2">Conversation Feed</h2>
            <div className="flex-1 overflow-y-auto pr-2 scrollbar-brutal flex flex-col gap-4" style={{ height: '600px' }}>
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center font-mono text-[var(--muted)] border-2 border-dashed border-[var(--border)]">
                  // NO DATA IN BUFFER //
                </div>
              ) : (
                messages.map((message) => (
                  <article
                    key={message.id}
                    className={cn(
                      'border-2 p-4 font-mono text-sm transition-all',
                      message.role === 'assistant'
                        ? 'border-[var(--accent)] bg-[rgba(255,71,15,0.05)] ml-4'
                        : message.role === 'user'
                          ? 'border-[var(--text)] bg-[var(--panel-strong)] mr-4'
                          : 'border-[var(--border)]'
                    )}
                  >
                    <div className="flex justify-between items-center text-[10px] uppercase font-bold text-[var(--muted)] border-b border-[var(--border)] pb-2 mb-3">
                      <span>{message.role} {message.speakerId ? `[${message.speakerId}]` : ''}</span>
                    </div>

                    {message.reasoning && (
                      <div className="bg-[var(--bg)] border-l-4 border-[var(--muted)] p-3 mb-3 text-xs text-[var(--muted)]">
                        {message.reasoning}
                      </div>
                    )}

                    {message.toolCalls?.length ? (
                      <div className="flex flex-col gap-2 mb-3">
                        {message.toolCalls.map((tc, idx) => (
                          <div key={idx} className="bg-[var(--panel-strong)] border border-[var(--accent-warm)] p-2 text-xs text-[var(--accent-warm)]">
                            <span className="font-bold">{tc.function.name}</span>() &rarr; {tc.function.arguments}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="text-[var(--text)] leading-relaxed whitespace-pre-wrap">
                      {message.content || '[NO CONTENT]'}
                    </div>
                  </article>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
          </section>

        </div>

        {/* Right Column (Metrics & Logs) */}
        <div className="lg:col-span-5 flex flex-col gap-8">
          
          <section className="panel p-6">
            <h2 className="text-xl font-bold uppercase border-b border-[var(--border)] pb-2 mb-4">Session Status</h2>
            <div className="grid grid-cols-2 gap-3 text-sm font-mono">
              <div className="bg-[var(--bg)] border border-[var(--border)] p-3">
                <div className="text-[10px] text-[var(--muted)] mb-1">SERVER</div>
                <div className="text-white truncate" title={DEFAULT_SERVER_URL}>{DEFAULT_SERVER_URL.replace(/^https?:\/\//, '')}</div>
              </div>
              <div className="bg-[var(--bg)] border border-[var(--border)] p-3">
                <div className="text-[10px] text-[var(--muted)] mb-1">SERVER MODE</div>
                <div className="text-[var(--accent-warm)]">{status?.interventionMode ?? interventionMode}</div>
              </div>
              <div className="bg-[var(--bg)] border border-[var(--border)] p-3 col-span-2 flex justify-between">
                <div>
                  <div className="text-[10px] text-[var(--muted)] mb-1">LAST THINKER</div>
                  <div className="text-white">{status?.lastThinkerRunAt ? new Date(status.lastThinkerRunAt).toLocaleTimeString() : 'N/A'}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-[var(--muted)] mb-1">INTERVAL</div>
                  <div className="text-white">{status?.thinkerIntervalSec ?? thinkerIntervalSec}s</div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel p-6">
            <h2 className="text-xl font-bold uppercase border-b border-[var(--border)] pb-2 mb-4">Belief Store</h2>
            
            <div className="flex flex-col gap-4 font-mono text-sm">
              <div className="border border-[var(--border)] bg-[var(--bg)]">
                <div className="bg-[var(--text)] text-[var(--bg)] px-3 py-1 text-xs font-bold uppercase">Discussion State</div>
                <div className="p-3">
                  <div className="text-[var(--text)]">{beliefStore?.discussion_state.currentTopic ?? 'NO TOPIC'}</div>
                  <div className="text-xs text-[var(--muted)] mt-2">PHASE: {beliefStore?.discussion_state.phase ?? 'UNKNOWN'}</div>
                  <div className="text-xs text-[var(--muted)] mt-1">OPEN q: {(beliefStore?.discussion_state.openQuestions ?? []).join(', ') || 'NONE'}</div>
                </div>
              </div>

              <div className="border border-[var(--border)] bg-[var(--bg)]">
                <div className="bg-[var(--text)] text-[var(--bg)] px-3 py-1 text-xs font-bold uppercase">Plan</div>
                <ul className="p-3 space-y-1 text-xs text-[var(--text)] list-disc list-inside">
                  {(beliefStore?.facilitation_plan ?? []).length ? (
                    beliefStore?.facilitation_plan.map((item, idx) => <li key={idx}>{item}</li>)
                  ) : (
                    <li className="list-none text-[var(--muted)]">NO PLAN DETECTED</li>
                  )}
                </ul>
              </div>

              <div className="border border-[var(--border)] bg-[var(--bg)]">
                <div className="bg-[var(--text)] text-[var(--bg)] px-3 py-1 text-xs font-bold uppercase">Actors</div>
                <div className="p-3 flex flex-col gap-2">
                  {(beliefStore?.participants ?? []).length ? (
                    beliefStore?.participants.map((p) => (
                      <div key={p.id} className="border border-[var(--border)] p-2">
                        <div className="text-[var(--accent)] font-bold">{p.id}</div>
                        <div className="text-xs mt-1 text-[var(--muted)]">
                          {p.stance} | {p.emotionalTone} | {p.engagementLevel}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-[var(--muted)]">NO ACTORS</div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="panel p-6">
            <h2 className="text-xl font-bold uppercase border-b border-[var(--danger)] pb-2 mb-4 text-[var(--danger)]">Directives</h2>
            <div className="flex flex-col gap-4 font-mono text-xs">
              <div>
                <div className="text-[var(--muted)] mb-2 font-bold uppercase">Pending Queue</div>
                <div className="space-y-2">
                  {pendingDirectives.length === 0 && <div className="text-[var(--muted)]">EMPTY</div>}
                  {pendingDirectives.map(d => (
                    <div key={d.id} className="border-l-4 border-[var(--accent-warm)] bg-[var(--panel-strong)] p-2 text-[var(--text)]">
                      <div className="flex justify-between text-[10px] text-[var(--muted)] mb-1">
                        <span>{d.priority}</span>
                        <span>{new Date(d.createdAt).toLocaleTimeString()}</span>
                      </div>
                      {d.instruction}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[var(--muted)] mb-2 font-bold uppercase">Fulfilled</div>
                <div className="space-y-2 text-[var(--muted)] opacity-70">
                  {fulfilledDirectives.length === 0 && <div>EMPTY</div>}
                  {fulfilledDirectives.map(d => (
                    <div key={d.id} className="border-l-2 border-[var(--border)] bg-[var(--bg)] p-2">
                      {d.instruction}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="panel p-6">
            <h2 className="text-xl font-bold uppercase border-b border-[var(--border)] pb-2 mb-4">Event Log</h2>
            <div className="overflow-y-auto scrollbar-brutal font-mono text-xs space-y-2 pr-2 flex flex-col" style={{ height: '240px' }}>
              {events.map(ev => (
                <div key={ev.id} className="bg-[var(--bg)] border border-[var(--border)] p-2">
                  <div className="flex justify-between text-[9px] text-[var(--accent)] mb-1 uppercase tracking-widest">
                    <span>{ev.type}</span>
                    <span>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-[var(--text)] break-all">{ev.details}</div>
                </div>
              ))}
              <div ref={eventsEndRef} />
            </div>
          </section>

        </div>
      </div>
    </main>
  );
}
