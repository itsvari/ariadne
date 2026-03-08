"use client";

import { useSTT } from "@/hooks/useSTT";
import { SystemEvent, Message } from "@/lib/types";
import { Mic, MicOff, Activity, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function AriadneDashboard() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  const addEvent = useCallback((type: SystemEvent["type"], details: string) => {
    setEvents(previousEvents => [...previousEvents, {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      details
    }]);
  }, []);

  const playTextToSpeechFallback = (text: string) => {
    // basic fallback since INWORLD_API_KEY isn't available yet
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleUtteranceFinal = useCallback(async (text: string) => {
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    setMessages(previousMessages => [...previousMessages, userMessage]);
    addEvent('UtteranceFinal', text);

    try {
      // allow api failure fallback handling
      const apiResponse = await fetch('/api/talker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMessage].map(message => ({ role: message.role, content: message.content })) })
      });
      
      if (!apiResponse.ok) {
        throw new Error(`API Error: ${apiResponse.statusText}`);
      }

      const data = await apiResponse.json();
      
      const assistantMessage: Message = { id: crypto.randomUUID(), role: 'assistant', content: "" };
      
      if (data.tool_calls) {
        for (const call of data.tool_calls) {
           const args = JSON.parse(call.function.arguments);
            if (call.function.name === 'speak') {
              assistantMessage.content += args.text + " ";
              addEvent('Speak', args.text);
              playTextToSpeechFallback(args.text);
           } else if (call.function.name === 'avatar_command') {
              addEvent('AvatarCommand', JSON.stringify(args));
           }
        }
      } else if (data.content) {
        assistantMessage.content = data.content;
      }
      
      if (assistantMessage.content) {
         setMessages(previousMessages => [...previousMessages, assistantMessage]);
         addEvent('TalkerResponse', assistantMessage.content);
      } else if (data.tool_calls && assistantMessage.content === "") {
         assistantMessage.content = "*Performed Actions*";
         setMessages(previousMessages => [...previousMessages, assistantMessage]);
      }

    } catch (apiError: unknown) {
      console.error(apiError);
      const errorMessage = apiError instanceof Error ? apiError.message : "Internal Error";
      addEvent('System', `Talker API: ${errorMessage}`);
    }
  }, [messages, addEvent]);

  const { isRecording, startRecording, stopRecording, interimResult } = useSTT(handleUtteranceFinal);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div className="min-h-screen p-8 max-w-7xl mx-auto flex flex-col gap-6">
      <header className="flex items-center justify-between pb-6 border-b border-white/10">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
            Ariadne Minimal Demo
          </h1>
          <p className="text-sm text-zinc-400 mt-1">Talker system with STT/TTS pipeline</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Activity className={cn("w-4 h-4", isRecording ? "text-green-400 animate-pulse" : "text-zinc-600")} />
            {isRecording ? "Listening..." : "Idle"}
          </div>
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={cn(
              "flex items-center gap-2 px-6 py-2.5 rounded-full font-medium transition-all duration-300",
              isRecording 
                ? "bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20" 
                : "bg-blue-600 text-white hover:bg-blue-500 shadow-xl shadow-blue-500/20"
            )}
          >
            {isRecording ? <><MicOff className="w-5 h-5" /> Stop Mic</> : <><Mic className="w-5 h-5" /> Start Mic</>}
          </button>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1">
        
        {/* Left Column: Chat & STT */}
        <div className="flex flex-col gap-6">
          <section className="bg-zinc-900/50 border border-white/10 rounded-2xl p-6 flex-1 flex flex-col backdrop-blur-sm shadow-xl">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-zinc-100">
              <Mic className="w-5 h-5 text-blue-400" />
              Conversation Stream
            </h2>
            
            <div className="flex-1 overflow-y-auto space-y-4 pr-4">
              {messages.length === 0 && (
                <p className="text-zinc-500 italic text-center mt-10">No conversation yet. Start the mic and say hello!</p>
              )}
              {messages.map((message) => (
                <div key={message.id} className={cn("flex w-full", message.role === 'user' ? "justify-end" : "justify-start")}>
                  <div className={cn(
                    "max-w-[80%] rounded-2xl px-5 py-3 text-sm leading-relaxed",
                    message.role === 'user' 
                      ? "bg-blue-600/20 border border-blue-500/30 text-blue-50" 
                      : "bg-zinc-800/80 border border-white/5 text-zinc-200 shadow-lg"
                  )}>
                    <span className="text-[10px] font-bold uppercase tracking-wider mb-1 block opacity-50">
                      {message.role === 'user' ? 'Player' : 'Ariadne Talker'}
                    </span>
                    {message.content}
                  </div>
                </div>
              ))}
              {interimResult && (
                 <div className="flex w-full justify-end">
                    <div className="max-w-[80%] rounded-2xl px-5 py-3 text-sm leading-relaxed bg-blue-600/5 border border-blue-500/10 text-zinc-400 animate-pulse">
                      {interimResult}
                    </div>
                 </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </section>
        </div>

        {/* Right Column: System Logs */}
        <div className="flex flex-col gap-6">
          <section className="bg-[#0a0a0a] border border-zinc-800/50 rounded-2xl p-6 flex-1 flex flex-col backdrop-blur-md shadow-2xl font-mono">
            <h2 className="text-sm uppercase tracking-widest text-zinc-500 mb-4 flex items-center gap-2 font-sans font-bold">
              <Terminal className="w-4 h-4" />
              Event Bus Log
            </h2>
            
            <div className="flex-1 overflow-y-auto space-y-3 pr-2 text-xs">
              {events.length === 0 && (
                <p className="text-zinc-700 italic">Waiting for events...</p>
              )}
              {events.map((event) => (
                <div key={event.id} className="border-l-2 pl-3 py-1 border-zinc-800 hover:border-zinc-600 transition-colors">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-zinc-600">{new Date(event.timestamp).toLocaleTimeString()}</span>
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide",
                      event.type === 'UtteranceFinal' && "bg-blue-500/10 text-blue-400",
                      event.type === 'AvatarCommand' && "bg-purple-500/10 text-purple-400",
                      event.type === 'Speak' && "bg-emerald-500/10 text-emerald-400",
                      event.type === 'System' && "bg-red-500/10 text-red-400",
                      event.type === 'TalkerResponse' && "bg-zinc-800 text-zinc-300",
                    )}>
                      {event.type}
                    </span>
                  </div>
                  <div className="text-zinc-400 break-words leading-relaxed">{event.details}</div>
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
