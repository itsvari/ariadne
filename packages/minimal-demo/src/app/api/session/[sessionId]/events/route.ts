import { NextRequest, NextResponse } from 'next/server';
import { sessionStore } from '@/server/telemetry/session-store';

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;

  const events = sessionStore.getEvents(sessionId);

  if (events.length === 0) {
    return NextResponse.json(
      { error: 'No events found for this session' },
      { status: 404 },
    );
  }

  const url = new URL(_req.url);
  const typeFilter = url.searchParams.get('type');

  const filtered = typeFilter
    ? events.filter((e) => e.type === typeFilter)
    : events;

  return NextResponse.json({
    sessionId,
    count: filtered.length,
    events: filtered,
  });
}
