import { DeepgramClient } from '@deepgram/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

const ENDPOINTING_DURATION_MS = 500;
const RECORDING_TIMESLICE_MS = 250;

export function useSTT(onUtteranceFinal: (text: string, speakerId?: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [interimResult, setInterimResult] = useState('');
  const currentSpeakerRef = useRef<string | undefined>(undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const connectionRef = useRef<Awaited<ReturnType<DeepgramClient['listen']['v1']['connect']>> | null>(null);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
    }
    if (connectionRef.current) {
      connectionRef.current.socket?.close();
    }
    setIsRecording(false);
    setInterimResult('');
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
      if (!apiKey || apiKey.startsWith('your_')) {
        throw new Error('Set NEXT_PUBLIC_DEEPGRAM_API_KEY before using live STT.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;

      const deepgram = new DeepgramClient({ apiKey });
      const connection = await deepgram.listen.v1.connect({
        Authorization: `Token ${apiKey}`,
        model: 'nova-3',
        language: 'en',
        smart_format: 'true',
        interim_results: 'true',
        endpointing: ENDPOINTING_DURATION_MS,
        diarize: 'true',
      });

      connectionRef.current = connection;

      connection.on('open', () => {
        setIsRecording(true);
        mediaRecorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0 && connection.socket?.readyState === 1) {
            connection.socket.send(event.data);
          }
        });
        mediaRecorder.start(RECORDING_TIMESLICE_MS);
      });

      connection.on('message', (payload: unknown) => {
        const data = payload as {
          type: string;
          is_final: boolean;
          channel: { alternatives: Array<{ transcript: string; words?: Array<{ speaker?: number }> }> };
        };

        if (data.type !== 'Results') {
          return;
        }

        const alternative = data.channel.alternatives[0];
        const transcript = alternative?.transcript;
        const speaker = alternative?.words?.[alternative.words.length - 1]?.speaker;

        currentSpeakerRef.current = speaker !== undefined ? String(speaker) : currentSpeakerRef.current;

        if (!transcript) {
          return;
        }

        if (data.is_final) {
          setInterimResult('');
          setTimeout(() => onUtteranceFinal(transcript, currentSpeakerRef.current), 0);
          return;
        }

        setInterimResult(transcript);
      });

      connection.on('close', () => {
        setIsRecording(false);
      });
      connection.on('error', (error) => {
        console.error(error);
      });

      connection.connect();
      await connection.waitForOpen();
    } catch (error) {
      stopRecording();
      alert(error instanceof Error ? error.message : 'Unable to start recording.');
    }
  }, [onUtteranceFinal, stopRecording]);

  useEffect(() => stopRecording, [stopRecording]);

  return { isRecording, interimResult, startRecording, stopRecording };
}
