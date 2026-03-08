"use client";

import { useSTT } from "@/hooks/useSTT";
import { SystemEvent, Message } from "@/lib/types";
import { Mic, MicOff, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const isFeedback = (spoken: string, heard: string) => {
  if (!spoken || !heard) return false;
  const cleanSpoken = spoken.toLowerCase().replace(/[^\w\s]/g, '');
  const cleanHeard = heard.toLowerCase().replace(/[^\w\s]/g, '');
  
  if (cleanSpoken.includes(cleanHeard) || cleanHeard.includes(cleanSpoken)) return true;
  
  const heardWords = cleanHeard.split(/\s+/).filter(w => w.length > 0);
  const spokenWords = cleanSpoken.split(/\s+/).filter(w => w.length > 0);
  
  if (heardWords.length === 0) return false;
  
  let matchCount = 0;
  for (const w of heardWords) {
    if (spokenWords.includes(w)) matchCount++;
  }
  return (matchCount / heardWords.length) > 0.6;
};

export default function AriadneDashboard() {
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpokenTextRef = useRef<string>("");
  const isSynthesizingRef = useRef<boolean>(false);

  const addEvent = useCallback((type: SystemEvent["type"], details: string) => {
    setEvents(previousEvents => [...previousEvents, {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      details
    }]);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const playInworldTTS = async (text: string) => {
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      if (!response.ok) {
        throw new Error(`TTS API HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const mediaSource = new MediaSource();
      const url = URL.createObjectURL(mediaSource);
      const audio = new Audio(url);
      
      currentAudioRef.current = audio;
      lastSpokenTextRef.current = text;
      isSynthesizingRef.current = true;
      
      audio.onended = () => {
        isSynthesizingRef.current = false;
        URL.revokeObjectURL(url);
      };

      mediaSource.addEventListener('sourceopen', async () => {
        let sourceBuffer: SourceBuffer;
        try {
          sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        } catch (e) {
          console.error("MediaSource addSourceBuffer error", e);
          return;
        }

        const queue: Uint8Array[] = [];
        let isAppending = false;

        const processQueue = () => {
          if (mediaSource.readyState !== 'open' || !sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
          isAppending = true;
          try {
            sourceBuffer.appendBuffer(queue.shift()! as BufferSource);
          } catch (e) {
            console.error("AppendBuffer error", e);
            isAppending = false;
          }
        };

        sourceBuffer.addEventListener('updateend', () => {
          isAppending = false;
          processQueue();
        });

        audio.play().catch(e => console.log("Audio play deferred or failed", e));

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              const checkInterval = setInterval(() => {
                if (!isAppending && queue.length === 0) {
                  clearInterval(checkInterval);
                  if (mediaSource.readyState === 'open') {
                    mediaSource.endOfStream();
                  }
                }
              }, 50);
              break;
            }
            if (value) {
              queue.push(value);
              processQueue();
            }
          }
        } catch (err) {
          console.error("Stream reading error:", err);
        }
      });
    } catch (err) {
      console.error('Inworld TTS Playback error:', err);
      // basic fallback if inworld fails
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        lastSpokenTextRef.current = text;
        isSynthesizingRef.current = true;
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => { isSynthesizingRef.current = false; };
        window.speechSynthesis.speak(utterance);
      }
    }
  };

  const handleUtteranceFinal = useCallback(async (text: string, speakerId?: number) => {
    if (isFeedback(lastSpokenTextRef.current, text)) {
      addEvent('System', `Ignored STT Audio Feedback: "${text}"`);
      return;
    }

    if (isSynthesizingRef.current) {
      if (currentAudioRef.current) currentAudioRef.current.pause();
      else if (window.speechSynthesis) window.speechSynthesis.cancel();
      isSynthesizingRef.current = false;
      addEvent('System', 'Barge-in detected, TTS playback halted.');
    }

    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text, speakerId };
    
    // Capture the most up-to-date conversational context before the state setter
    const currentContext = [...messagesRef.current, userMessage];
    
    setMessages(previousMessages => [...previousMessages, userMessage]);
    addEvent('UtteranceFinal', text);

    try {
      // allow api failure fallback handling
      const apiResponse = await fetch('/api/talker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: currentContext.map(message => ({ 
            role: message.role, 
            content: message.role === 'user' && message.speakerId !== undefined 
              ? `[Speaker ${message.speakerId}]: ${message.content}` 
              : message.role === 'assistant' && !message.content && message.toolCalls && message.toolCalls.length > 0
                ? `*[System Note: You previously performed the following actions - ${message.toolCalls.map(c => c.name).join(', ')}]*`
                : message.content || ""
          })) 
        })
      });
      
      if (!apiResponse.ok) {
        throw new Error(`API Error: ${apiResponse.statusText}`);
      }

      const data = await apiResponse.json();
      
      const assistantMessage: Message = { id: crypto.randomUUID(), role: 'assistant', content: "" };
      
      if (data.content) {
        assistantMessage.reasoning = data.content;
      }

      if (data.tool_calls) {
        assistantMessage.toolCalls = [];
        for (const call of data.tool_calls) {
           const args = JSON.parse(call.function.arguments);
           assistantMessage.toolCalls.push({ name: call.function.name, args: call.function.arguments });
           
            if (call.function.name === 'speak') {
              assistantMessage.content += (args.text || "") + " ";
              addEvent('Speak', args.text);
              playInworldTTS(args.text);
           } else if (call.function.name === 'avatar_command') {
              addEvent('AvatarCommand', JSON.stringify(args));
           }
        }
      } else if (data.content) {
        assistantMessage.content = data.content;
      }
      
      setMessages(previousMessages => [...previousMessages, assistantMessage]);
      addEvent('TalkerResponse', assistantMessage.content || assistantMessage.reasoning || "*Performed Actions*");

    } catch (apiError: unknown) {
      console.error(apiError);
      const errorMessage = apiError instanceof Error ? apiError.message : "Internal Error";
      addEvent('System', `Talker API: ${errorMessage}`);
    }
  }, [messages, addEvent]);

  const { isRecording, startRecording, stopRecording, interimResult } = useSTT(handleUtteranceFinal);

  useEffect(() => {
    if (interimResult && isSynthesizingRef.current) {
      if (!isFeedback(lastSpokenTextRef.current, interimResult) && interimResult.trim().split(/\s+/).length > 0) {
        if (currentAudioRef.current) currentAudioRef.current.pause();
        else if (window.speechSynthesis) window.speechSynthesis.cancel();
        isSynthesizingRef.current = false;
        addEvent('System', 'Barge-in detected (interim), TTS playback halted.');
      }
    }
  }, [interimResult, addEvent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interimResult]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div className="h-[100dvh] overflow-hidden bg-[#000] text-zinc-300 font-mono p-4 md:p-8 flex flex-col gap-8 selection:bg-zinc-800 selection:text-zinc-100">
      <header className="flex flex-col md:flex-row md:items-end justify-between pb-6 border-b-2 border-zinc-800 gap-4 shrink-0">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl md:text-3xl font-bold tracking-[0.2em] uppercase text-zinc-100 flex items-center gap-3">
            <span className="w-4 h-4 bg-red-600 inline-block animate-pulse"></span>
            Ariadne
            <span className="text-zinc-700 font-light">/</span>
            Demo
          </h1>
          <div className="flex items-center gap-3">
            <p className="text-[10px] tracking-widest text-zinc-500 uppercase">Audio Interface Terminal // Node.01</p>
            <span className="px-2 py-0.5 border border-red-600/30 bg-red-600/10 text-red-500 text-[9px] uppercase tracking-widest font-bold">MVP: Talker Active</span>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 text-xs uppercase tracking-widest">
            <span className={cn(
              "w-2 h-2 rounded-none",
              isRecording ? "bg-red-500 animate-pulse" : "bg-zinc-700"
            )} />
            <span className={isRecording ? "text-red-500" : "text-zinc-500"}>
              {isRecording ? "Uplink_Active" : "Standby"}
            </span>
          </div>
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={cn(
              "flex items-center gap-3 px-6 py-3 text-xs font-bold uppercase tracking-widest border-2 transition-none",
              isRecording 
                ? "border-red-500 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-black" 
                : "border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-100 hover:text-black hover:border-zinc-100"
            )}
          >
            {isRecording ? (
              <><MicOff className="w-4 h-4" /> Terminate</>
            ) : (
              <><Mic className="w-4 h-4" /> Initialize</>
            )}
          </button>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-2 gap-8 flex-1 min-h-0">
        
        {/* Left Column: Chat & STT */}
        <div className="flex flex-col min-h-0">
          <section className="border-2 border-zinc-800 bg-[#050505] p-0 flex-1 flex flex-col relative overflow-hidden group min-h-0">
            <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-zinc-500"></div>
            <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-zinc-500"></div>
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-zinc-500"></div>
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-zinc-500"></div>

            <div className="p-4 border-b-2 border-zinc-800 bg-[#0a0a0a] flex items-center justify-between">
              <h2 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 select-none">
                Transmissions
              </h2>
              <span className="text-[10px] text-zinc-700 font-mono">PTR-{messages.length.toString().padStart(3, '0')}</span>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {messages.length === 0 && (
                <div className="h-full flex items-center justify-center text-[10px] tracking-widest uppercase text-zinc-600">
                  [ Awaiting Audio Input ]
                </div>
              )}
              {messages.map((message) => (
                <div key={message.id} className="flex flex-col gap-2">
                  {message.role === 'user' ? (
                    <div className="pl-4 border-l-2 border-zinc-500 bg-zinc-900/30 p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] font-bold text-zinc-500 block uppercase tracking-widest">User_Input</span>
                        {message.speakerId !== undefined && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-zinc-800 text-zinc-400 border border-zinc-700">
                            SPK_{message.speakerId}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-zinc-300 font-sans">
                        {message.content}
                      </div>
                    </div>
                  ) : (
                    <div className="pl-4 border-l-2 border-blue-600 bg-blue-950/10 p-4 relative">
                      <span className="text-[10px] font-bold text-blue-500 mb-2 block uppercase tracking-widest">Ariadne_Response</span>
                      
                      {message.reasoning && (
                        <div className="mb-4 pl-3 border-l-2 py-2 text-[10px] bg-black border-zinc-800 text-zinc-500 break-words font-mono">
                          <span className="font-bold text-zinc-700 mb-1 block uppercase tracking-widest">Sys.Reasoning</span>
                          {message.reasoning}
                        </div>
                      )}
                      
                      {message.toolCalls && message.toolCalls.map((call, idx) => (
                        <div key={idx} className="mb-4 pl-3 border-l-2 py-2 text-[10px] bg-black border-blue-900/50 text-blue-400 break-words font-mono">
                          <span className="font-bold text-blue-700 mb-1 block uppercase tracking-widest">Exe.{call.name}</span>
                          <pre className="whitespace-pre-wrap">{call.args}</pre>
                        </div>
                      ))}
                      
                      {message.content && (
                        <div className="text-sm text-zinc-100 mt-2 font-sans leading-relaxed">
                          {message.content}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {interimResult && (
                 <div className="pl-4 border-l-2 border-red-500/50 bg-red-950/20 p-4 animate-pulse">
                    <span className="text-[10px] font-bold text-red-500/50 mb-2 block uppercase tracking-widest">Buffering...</span>
                    <div className="text-sm text-zinc-400 font-sans">
                      {interimResult}
                    </div>
                 </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </section>
        </div>

        {/* Right Column: System Logs */}
        <div className="flex flex-col min-h-0">
          <section className="border-2 border-zinc-800 bg-[#050505] p-0 flex-1 flex flex-col relative overflow-hidden group min-h-0">
            <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-zinc-500"></div>
            <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-zinc-500"></div>
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-zinc-500"></div>
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-zinc-500"></div>

            <div className="p-4 border-b-2 border-zinc-800 bg-[#0a0a0a] flex items-center justify-between">
              <h2 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 flex items-center gap-2 select-none">
                <Terminal className="w-3 h-3" />
                Event Matrix
              </h2>
              <span className="text-[10px] text-zinc-700 animate-pulse font-mono tracking-widest uppercase">Live</span>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono">
              {events.length === 0 && (
                <div className="h-full flex items-center justify-center text-[10px] tracking-widest uppercase text-zinc-600">
                  [ Logs Empty ]
                </div>
              )}
              {events.map((event) => (
                <div key={event.id} className="flex flex-col lg:flex-row gap-2 lg:gap-4 lg:items-start py-2 border-b border-zinc-900/50 hover:bg-zinc-900/50 px-2 transition-colors">
                  <span className="text-[9px] text-zinc-600 whitespace-nowrap lg:mt-[2px]">
                    {new Date(event.timestamp).toISOString().split('T')[1].slice(0, 12)}
                  </span>
                  <span className={cn(
                    "text-[9px] font-bold uppercase tracking-widest lg:w-28 flex-shrink-0 lg:mt-[2px]",
                    event.type === 'UtteranceFinal' ? "text-zinc-400" :
                    event.type === 'AvatarCommand' ? "text-zinc-500" :
                    event.type === 'Speak' ? "text-blue-500" :
                    event.type === 'System' ? "text-red-600" :
                    "text-blue-500"
                  )}>
                    {event.type}
                  </span>
                  <div className="text-[10px] text-zinc-400 break-words flex-1 leading-snug">
                    {event.details}
                  </div>
                </div>
              ))}
              <div ref={eventsEndRef} />
            </div>
          </section>
        </div>

      </main>
    </div>
  );
}
