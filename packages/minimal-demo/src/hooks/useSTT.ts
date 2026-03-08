import { DeepgramClient } from "@deepgram/sdk";
import { useCallback, useRef, useState, useEffect } from "react";

const ENDPOINTING_DURATION_MS = 500;
const RECORDING_TIMESLICE_MS = 250;

export function useSTT(onUtteranceFinal: (text: string, speakerId?: number) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [interimResult, setInterimResult] = useState("");
  const currentSpeakerRef = useRef<number | undefined>(undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const connectionRef = useRef<Awaited<ReturnType<DeepgramClient['listen']['v1']['connect']>> | null>(null); // deepgram v1 connection

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;

      const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
      if (!apiKey || apiKey === "your_deepgram_api_key_here") {
        alert("Please set NEXT_PUBLIC_DEEPGRAM_API_KEY in your .env.local file.");
        return;
      }
      
      const deepgram = new DeepgramClient({ apiKey });
      // @ts-expect-error Authorization type issue in SDK
      const connection = await deepgram.listen.v1.connect({
        model: "nova-3",
        language: "en",
        smart_format: "true",
        interim_results: "true",
        endpointing: ENDPOINTING_DURATION_MS,
        diarize: "true",
      });

      connectionRef.current = connection;

      connection.on("open", () => {
        setIsRecording(true);
        mediaRecorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0 && connection.socket?.readyState === 1) {
            connection.socket.send(event.data);
          }
        });
        mediaRecorder.start(RECORDING_TIMESLICE_MS);
      });

      connection.on("message", (transcriptionPayload: unknown) => {
        const data = transcriptionPayload as { 
          type: string, 
          is_final: boolean, 
          channel: { alternatives: { transcript: string, words?: { speaker?: number }[] }[] } 
        };
        
        if (data.type === "Results") {
           const transcript = data.channel.alternatives[0]?.transcript;
           const words = data.channel.alternatives[0]?.words;
           
           if (words && words.length > 0) {
             currentSpeakerRef.current = words[words.length - 1].speaker;
           }

           if (transcript && transcript !== "") {
             if (data.is_final) {
               setInterimResult("");
               setTimeout(() => onUtteranceFinal(transcript, currentSpeakerRef.current), 0);
             } else {
               setInterimResult(transcript);
             }
           }
        }
      });
      
      connection.on("error", (errorPayload: unknown) => console.error(errorPayload));
      connection.on("close", () => setIsRecording(false));

      connection.connect();
      await connection.waitForOpen();

    } catch (connectionError: unknown) {
      console.error(connectionError);
      const errorMessage = connectionError instanceof Error ? connectionError.message : "Unknown connection error";
      alert(`Microphone permission denied or Deepgram error: ${errorMessage}`);
    }
  }, [onUtteranceFinal]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
    if (connectionRef.current) {
      connectionRef.current.socket?.close();
    }
    setIsRecording(false);
    setInterimResult("");
  }, []);

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, [stopRecording]);

  return { isRecording, startRecording, stopRecording, interimResult };
}
