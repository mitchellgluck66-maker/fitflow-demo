/**
 * Companion stage 2 — constants the pop-out (a client component) shares with the server's log module.
 */
export const NOTE_MIN_CHARS = 10;

export type AppointmentWord = 'showed' | 'noshow' | 'cancelled' | 'leave';
/** The appointment effect as the sheet, the footer line and the note say it. */
export const APPOINTMENT_WORDS: Record<AppointmentWord, string> = { showed: 'showed', noshow: 'no-show', cancelled: 'cancelled', leave: 'left as is' };
