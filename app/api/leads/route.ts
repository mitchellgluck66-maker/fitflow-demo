import { NextRequest, NextResponse } from 'next/server';
import { db, leads } from '@/db/index';
import { desc } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  try {
    // Get all leads sorted by most recent first
    const allLeads = await db
      .select()
      .from(leads)
      .orderBy(desc(leads.createdAt))
      .all();

    return NextResponse.json(allLeads, { status: 200 });
  } catch (error) {
    console.error('Failed to fetch leads:', error);
    return NextResponse.json(
      { error: 'Failed to fetch leads' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields
    if (!body.firstName || !body.lastName || !body.email) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Create new lead
    const newLead = {
      id: `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone || '',
      pipelineId: '[new] Application Pipeline',
      pipelineName: '[new] Application Pipeline',
      stage: 'Applied',
      status: 'active',
      source: body.source || 'Manual Entry',
      originalSource: body.source || 'Manual Entry',
      utmSource: body.utmSource || (body.source || 'Manual Entry').toLowerCase(),
      utmCampaign: body.utmCampaign || 'Direct',
      utmMedium: body.utmMedium || 'manual',
      entryFunnel: 'Manual Entry',
      ghlSource: 'Manual Entry',
      appointmentTime: body.appointmentTime || new Date().toISOString(),
      appointmentStatus: 'scheduled',
      estimatedValue: body.estimatedValue || 0,
      owner: body.owner || 'Unassigned',
      tags: JSON.stringify(body.tags || ['manual_entry']),
      notes: body.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dateApplied: new Date().toISOString(),
      lastActionAt: null,
    };

    const result = await db.insert(leads).values(newLead).run();

    return NextResponse.json(newLead, { status: 201 });
  } catch (error) {
    console.error('Failed to create lead:', error);
    return NextResponse.json(
      { error: 'Failed to create lead' },
      { status: 500 }
    );
  }
}
