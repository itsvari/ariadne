import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@ariadne/shared-contracts'],
  env: {
    NEXT_PUBLIC_DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  },
};

export default nextConfig;
