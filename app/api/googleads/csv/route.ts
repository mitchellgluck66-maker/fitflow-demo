import { NextRequest, NextResponse } from 'next/server';
import { importGoogleAdsCsv } from '@/lib/googleads/ingest';

export const dynamic = 'force-dynamic';

/**
 * POST /api/googleads/csv — multipart (field "file") or raw text/csv body.
 * Parses the Google Ads UI export and upserts ad_spend rows (origin
 * 'google_csv'). Idempotent per campaign+date.
 */
export async function POST(request: NextRequest) {
  try {
    let text = '';
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') return NextResponse.json({ ok: false, error: 'Attach a .csv file as "file".' }, { status: 400 });
      text = await file.text();
    } else {
      text = await request.text();
    }
    if (!text.trim()) return NextResponse.json({ ok: false, error: 'Empty file.' }, { status: 400 });
    if (text.length > 5_000_000) return NextResponse.json({ ok: false, error: 'File too large (5 MB max).' }, { status: 413 });

    const result = await importGoogleAdsCsv(text, { enteredBy: 'ads tab upload' });
    return NextResponse.json({
      ...result,
      message: result.ok
        ? `Imported ${result.imported} campaign-days (${result.dateRange?.start} → ${result.dateRange?.end}). Google spend for those dates now comes from the CSV.`
        : (result.warnings[0] ?? 'Nothing imported'),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Import failed', detail: String(error) }, { status: 500 });
  }
}
