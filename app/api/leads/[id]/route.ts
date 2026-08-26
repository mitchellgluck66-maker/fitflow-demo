import { NextRequest, NextResponse } from 'next/server';
import { db, leads, leadEvents } from '@/db/index';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const lead = await db
      .select()
      .from(leads)
      .where(eq(leads.id, id))
      .get();

    if (!lead) {
      return NextResponse.json(
        { error: 'Lead not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(lead, { status: 200 });
  } catch (error) {
    console.error('Failed to fetch lead:', error);
    return NextResponse.json(
      { error: 'Failed to fetch lead' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    // Get the current lead to track changes
    const currentLead = await db
      .select()
      .from(leads)
      .where(eq(leads.id, id))
      .get();

    if (!currentLead) {
      return NextResponse.json(
        { error: 'Lead not found' },
        { status: 404 }
      );
    }

    // Prepare update object
    const updateData: any = {
      updatedAt: new Date().toISOString(),
    };

    if (body.stage) updateData.stage = body.stage;
    if (body.appointmentStatus) updateData.appointmentStatus = body.appointmentStatus;
    if (body.status) updateData.status = body.status;
    if (body.owner) updateData.owner = body.owner;
    if (body.notes) updateData.notes = body.notes;

    // Update lead
    const updated = await db
      .update(leads)
      .set(updateData)
      .where(eq(leads.id, id))
      .run();

    // Create audit trail event if stage or status changed
    if (body.stage || body.appointmentStatus) {
      await db.insert(leadEvents).values({
        id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        leadId: id,
        action: body.action || 'StatusUpdate',
        priorStage: currentLead.stage,
        newStage: body.stage || currentLead.stage,
        appointmentStatus: body.appointmentStatus || currentLead.appointmentStatus,
        actor: body.actor || 'System',
        notes: body.notes || `Updated to ${body.stage || currentLead.stage}`,
        syncStatus: 'local',
        createdAt: new Date().toISOString(),
      }).run();
    }

    // Fetch and return updated lead
    const updatedLead = await db
      .select()
      .from(leads)
      .where(eq(leads.id, id))
      .get();

    return NextResponse.json(updatedLead, { status: 200 });
  } catch (error) {
    console.error('Failed to update lead:', error);
    return NextResponse.json(
      { error: 'Failed to update lead' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await db
      .delete(leads)
      .where(eq(leads.id, id))
      .run();

    return NextResponse.json(
      { message: 'Lead deleted' },
      { status: 200 }
    );
  } catch (error) {
    console.error('Failed to delete lead:', error);
    return NextResponse.json(
      { error: 'Failed to delete lead' },
      { status: 500 }
    );
  }
}
