import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@ariadne/shared-contracts': '/Users/vari/Developer/ariadne/packages/shared-contracts/src/index.ts',
      '@ariadne/chat-providers': '/Users/vari/Developer/ariadne/packages/chat-providers/src/index.ts',
      '@ariadne/shared-belief-store': '/Users/vari/Developer/ariadne/packages/shared-belief-store/src/index.ts',
      '@ariadne/event-bus': '/Users/vari/Developer/ariadne/packages/event-bus/src/index.ts',
      '@ariadne/talker': '/Users/vari/Developer/ariadne/packages/talker/src/index.ts',
      '@ariadne/thinker': '/Users/vari/Developer/ariadne/packages/thinker/src/index.ts',
      '@ariadne/tts-client': '/Users/vari/Developer/ariadne/packages/tts-client/src/index.ts',
    },
  },
});
