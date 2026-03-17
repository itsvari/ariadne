export const DEFAULT_SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8081';

export function serverUrl(path: string): string {
  return `${DEFAULT_SERVER_URL}${path}`;
}

export function eventSocketUrl(sessionId: string): string {
  const base = new URL(DEFAULT_SERVER_URL);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/events';
  base.searchParams.set('sessionId', sessionId);
  return base.toString();
}
