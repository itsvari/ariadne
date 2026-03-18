import WebSocket from 'ws';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = join(__dirname, 'test-output.mp3');

const GATEWAY_URL = process.env.WS_URL ?? 'ws://localhost:8081';
const SESSION_ID = 'audio-test-' + Date.now();
const MODE = process.env.MODE ?? 'control';

const TEST_MESSAGE = {
  type: 'utterance.final',
  sessionId: SESSION_ID,
  payload: {
    speakerId: 'tester',
    text: process.argv[2] ?? 'Ariadne, can you introduce yourself briefly?',
  },
};

console.log(`Connecting to ${GATEWAY_URL}?sessionId=${SESSION_ID}&mode=${MODE}`);

const ws = new WebSocket(`${GATEWAY_URL}?sessionId=${SESSION_ID}&mode=${MODE}`);

const audioChunks: Buffer[] = [];
let ttsStarted = false;
let finishRequested = false;
let ttsIdleTimer: NodeJS.Timeout | null = null;
const TTS_IDLE_MS = Number(process.env.TTS_IDLE_MS ?? 1800);

const TIMEOUT_MS = 30_000;
const timeout = setTimeout(() => {
  console.error('Timed out waiting for response.');
  closeSession(1);
}, TIMEOUT_MS);

function resetTtsIdleTimer() {
  if (ttsIdleTimer) clearTimeout(ttsIdleTimer);
  // Some providers keep WS/session alive after last chunk.
  // If chunk flow goes quiet after we already started TTS, finalize output.
  ttsIdleTimer = setTimeout(() => {
    if (ttsStarted && !finishRequested) {
      console.log(`\nNo new TTS chunks for ${TTS_IDLE_MS}ms. Finalizing stream.`);
      closeSession();
    }
  }, TTS_IDLE_MS);
}

function closeSession(exitCode = 0) {
  if (finishRequested) return;
  finishRequested = true;
  clearTimeout(timeout);
  if (ttsIdleTimer) clearTimeout(ttsIdleTimer);
  ws.close();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

ws.on('open', () => {
  console.log('Connected. Sending test message...');
  console.log(`  "${TEST_MESSAGE.payload.text}"`);
  ws.send(JSON.stringify(TEST_MESSAGE));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  switch (msg.type) {
    case 'talker.output': {
      const calls = msg.payload?.tool_calls;
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          const fn = tc.function;
          if (fn?.name === 'speak') {
            const args = JSON.parse(fn.arguments ?? '{}');
            console.log(`\nTalker will speak: "${args.text}"`);
          } else if (fn?.name === 'avatar_command') {
            const args = JSON.parse(fn.arguments ?? '{}');
            console.log(`\nTalker avatar command: ${args.command}`);
          }
        }
        const hasSpeakCall = calls.some(
          (tc: { function?: { name?: string } }) => tc.function?.name === 'speak',
        );
        if (!hasSpeakCall) {
          console.log('\nTalker chose not to speak (no speak tool call). No audio to play.');
          closeSession();
        }
      } else if (msg.payload?.content) {
        console.log(`\nTalker content: "${msg.payload.content}"`);
        console.log('No tool calls, so no TTS audio will follow.');
        closeSession();
      } else {
        console.log('\nTalker returned empty response.');
        closeSession();
      }
      break;
    }

    case 'tts.audio.chunk': {
      if (!ttsStarted) {
        ttsStarted = true;
        console.log('\nReceiving TTS audio chunks...');
      }
      const b64 = msg.payload?.audioBase64;
      if (b64) {
        audioChunks.push(Buffer.from(b64, 'base64'));
        process.stdout.write(`  chunk ${msg.payload.seq} (${audioChunks[audioChunks.length - 1].length} bytes)\r`);
        resetTtsIdleTimer();
      }
      break;
    }

    case 'tts.audio.done': {
      console.log(`\nTTS stream complete (${msg.payload?.totalChunks ?? '?'} chunks).`);
      closeSession();
      break;
    }

    case 'avatar.command': {
      const cmd = msg.payload?.command ?? 'unknown';
      console.log(`Avatar command: ${cmd}`);
      break;
    }

    case 'error': {
      console.error('Server error:', msg.payload?.error);
      closeSession(1);
      break;
    }
  }
});

ws.on('close', () => {
  clearTimeout(timeout);
  if (ttsIdleTimer) clearTimeout(ttsIdleTimer);

  if (audioChunks.length === 0) {
    console.log('\nNo audio chunks received.');
    process.exit(0);
  }

  const combined = Buffer.concat(audioChunks);
  writeFileSync(OUTPUT_FILE, combined);
  console.log(`\n\nSaved ${combined.length} bytes to ${OUTPUT_FILE}`);

  console.log('Playing audio...\n');
  try {
    execSync(`afplay "${OUTPUT_FILE}"`, { stdio: 'inherit' });
  } catch {
    console.log('afplay not available (macOS only). File saved at:', OUTPUT_FILE);
    console.log('Open it manually with any audio player.');
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  closeSession(1);
});
