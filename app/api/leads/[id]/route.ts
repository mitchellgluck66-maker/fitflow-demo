import { NextRequest, NextResponse } from 'next/server';
import { listContactsAsLeads } from '@/lib/queries/contacts';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const lead = (await listContactsAsLeads()).find((l) => l.id === id);
    if (!lead) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    return NextResponse.json(lead);
  } catch (error) {
    console.error('Failed to fetch contact:', error);
    return NextResponse.json({ error: 'Failed to fetch contact' }, { status: 500 });
  }
}

const READ_ONLY = {
  error: 'FitFlow is read-only. Edit this contact in GoHighLevel; the change appears here on the next sync.',
};

export async function PATCH() {
  return NextResponse.json(READ_ONLY, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json(READ_ONLY, { status: 405 });
}
