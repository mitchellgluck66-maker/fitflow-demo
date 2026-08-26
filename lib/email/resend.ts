/**
 * Resend transport. Never throws: a missing key or a transport failure is a
 * result the caller records in email_digests, not an exception.
 */

export interface SendResult {
  sent: boolean;
  id?: string;
  error?: string;
}

export function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM_EMAIL?.trim());
}

export async function sendEmail(params: {
  to: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey) return { sent: false, error: 'no_api_key' };
  if (!from) return { sent: false, error: 'no_from_email' };
  if (params.to.length === 0) return { sent: false, error: 'no_recipients' };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: params.to, subject: params.subject, html: params.html, text: params.text }),
    });
    const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok) {
      // Never include the API key in the message.
      return { sent: false, error: `Resend ${response.status}: ${payload.message ?? 'unknown error'}` };
    }
    return { sent: true, id: payload.id };
  } catch (err) {
    return { sent: false, error: `Failed to reach Resend: ${err instanceof Error ? err.message : String(err)}` };
  }
}
