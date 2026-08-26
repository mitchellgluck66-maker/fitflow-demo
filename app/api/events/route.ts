import { NextRequest, NextResponse } from 'next/server';
import { db, leadEvents } from '@/db/index';
import { desc } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  try {
    // Get all events sorted by most recent first
    const allEvents = await db
      .select()
      .from(leadEvents)
      .orderBy(desc(leadEvents.createdAt))
      .all();

    return NextResponse.json(allEvents, { status: 200 });
  } catch (error) {
    console.error('Failed to fetch events:', error);
    return NextResponse.json(
      { error: 'Failed to fetch events' },
      { status: 500 }
    );
  }
}
