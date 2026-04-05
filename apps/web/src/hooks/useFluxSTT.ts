import { DeepgramClient } from '@deepgram/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

const AUDIO_CHUNK_INTERVAL_MS = 80;
const SAMPLE_RATE_HZ = 16000;
const DEFAULT_SPEAKER_ID = 'local';
const SCRIPT_PROCESSOR_BUFFER_SIZE = 2048;

const SAMPLES_PER_CHUNK = (SAMPLE_RATE_HZ * AUDIO_CHUNK_INTERVAL_MS) / 1000;

export interface ParticipantStream {
  speakerId: string;
  stream: MediaStream;
}

interface FluxMessage {
  event: 'Update' | 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn' | 'Connected';
  turn_index: number;
  transcript: string;
  words?: Array<{ word: string; confidence: number }>;
  end_of_turn_confidence?: number;
}

type FluxConnection = Awaited<ReturnType<DeepgramClient['listen']['v2']['connect']>>;

interface ParticipantConnection {
  speakerId: string;
  connection: FluxConnection;
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  processorNode: ScriptProcessorNode;
}

function float32ToLinear16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    view.setInt16(i * 2, int16, true);
  }

  return buffer;
}

export function useFluxSTT(
  onUtteranceFinal: (text: string, speakerId: string) => void,
  onInterimUpdate?: (text: string, speakerId: string) => void,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [interimResults, setInterimResults] = useState<Map<string, string>>(new Map());
  const participantConnectionsRef = useRef<ParticipantConnection[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);

  const cleanupConnections = useCallback(() => {
    for (const participant of participantConnectionsRef.current) {
      participant.processorNode.disconnect();
      participant.sourceNode.disconnect();
      void participant.audioContext.close();
      participant.connection.socket?.close();
    }
    participantConnectionsRef.current = [];

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    cleanupConnections();
    setIsRecording(false);
    setInterimResults(new Map());
  }, [cleanupConnections]);

  const connectParticipant = useCallback(
    async (speakerId: string, stream: MediaStream): Promise<ParticipantConnection> => {
      const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
      if (!apiKey || apiKey.startsWith('your_')) {
        throw new Error('Set NEXT_PUBLIC_DEEPGRAM_API_KEY before using live STT.');
      }

      const deepgram = new DeepgramClient({ apiKey });
      const connection = await deepgram.listen.v2.connect({
        Authorization: `Token ${apiKey}`,
        model: 'flux-general-en',
        encoding: 'linear16',
        sample_rate: String(SAMPLE_RATE_HZ),
      });

      connection.on('message', (payload: unknown) => {
        const message = payload as FluxMessage;

        if (message.event === 'Connected') {
          return;
        }

        if (!message.transcript) {
          return;
        }

        if (message.event === 'EndOfTurn') {
          setInterimResults((previous) => {
            const next = new Map(previous);
            next.delete(speakerId);
            return next;
          });
          setTimeout(() => onUtteranceFinal(message.transcript, speakerId), 0);
          return;
        }

        setInterimResults((previous) => {
          const next = new Map(previous);
          next.set(speakerId, message.transcript);
          return next;
        });
        onInterimUpdate?.(message.transcript, speakerId);
      });

      connection.on('error', (error) => {
        console.error(`[Flux/${speakerId}]`, error);
      });

      connection.on('close', () => {
        console.info(`[Flux/${speakerId}] Connection closed.`);
      });

      connection.connect();
      await connection.waitForOpen();

      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE_HZ });
      const sourceNode = audioContext.createMediaStreamSource(stream);

      const processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);

      let sampleBuffer = new Float32Array(0);

      processorNode.onaudioprocess = (audioEvent) => {
        const inputData = audioEvent.inputBuffer.getChannelData(0);

        const combined = new Float32Array(sampleBuffer.length + inputData.length);
        combined.set(sampleBuffer);
        combined.set(inputData, sampleBuffer.length);
        sampleBuffer = combined;

        while (sampleBuffer.length >= SAMPLES_PER_CHUNK) {
          const chunk = sampleBuffer.subarray(0, SAMPLES_PER_CHUNK);
          const pcmData = float32ToLinear16(chunk);
          sampleBuffer = sampleBuffer.subarray(SAMPLES_PER_CHUNK);

          if (connection.socket?.readyState === WebSocket.OPEN) {
            connection.socket.send(pcmData);
          }
        }
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      return { speakerId, connection, audioContext, sourceNode, processorNode };
    },
    [onUtteranceFinal, onInterimUpdate],
  );

  const startRecording = useCallback(
    async (participants?: ParticipantStream[]) => {
      try {
        let streams: ParticipantStream[];

        if (participants && participants.length > 0) {
          streams = participants;
        } else {
          const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          localStreamRef.current = localStream;
          streams = [{ speakerId: DEFAULT_SPEAKER_ID, stream: localStream }];
        }

        const connections = await Promise.all(
          streams.map((participant) => connectParticipant(participant.speakerId, participant.stream)),
        );

        participantConnectionsRef.current = connections;
        setIsRecording(true);
      } catch (error) {
        stopRecording();
        alert(error instanceof Error ? error.message : 'Unable to start recording.');
      }
    },
    [connectParticipant, stopRecording],
  );

  useEffect(() => stopRecording, [stopRecording]);

  return { isRecording, interimResults, startRecording, stopRecording };
}
