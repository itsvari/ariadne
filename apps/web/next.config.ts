import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@ariadne/shared-contracts'],
};

export default nextConfig;
