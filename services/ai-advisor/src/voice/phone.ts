// Phone-number handling for the voice module. Australian numbering is the default: the CRM stores
// numbers as typed by staff ("0407 974 100", "(08) 8213 9955", "+61 8 8213 9955", "8213 9955"), Retell
// gives E.164. Everything is compared on normalised digits.

/** Digits only. */
export function digitsOf(s: string | null | undefined): string {
  return String(s ?? '').replace(/\D/g, '');
}

/**
 * Normalise to E.164 digits WITHOUT the plus (e.g. "61407974100"). AU rules: a leading "0" trunk
 * prefix becomes "61"; "61…" is kept; anything else with 10+ digits and no AU shape is assumed to be
 * already-international. Returns '' when there are too few digits to be a number.
 */
export function normalizeDigits(s: string | null | undefined, defaultCountry = '61'): string {
  let d = digitsOf(s);
  if (!d) return '';
  // "0011 61 …" international dialling prefix (AU) → drop it.
  if (d.startsWith('0011')) d = d.slice(4);
  if (d.startsWith('0') && d.length >= 9) return defaultCountry + d.slice(1);
  if (d.startsWith(defaultCountry) && d.length >= 11) return d;
  // Local number without an area code (8 digits, e.g. "8213 9955"): cannot resolve the area — keep as is.
  if (d.length < 8) return '';
  return d;
}

/** "+61407974100" from anything normalisable; null when it cannot be made E.164. */
export function toE164(s: string | null | undefined, defaultCountry = '61'): string | null {
  const d = normalizeDigits(s, defaultCountry);
  if (!d || d.length < 10 || d.length > 15) return null;
  return `+${d}`;
}

/** The last 9 digits — the AU national significant number (mobile 4xxxxxxxx / landline area+local).
 *  Used for candidate lookup against however staff typed the number into the CRM. */
export function nsn9(s: string | null | undefined): string {
  const d = digitsOf(s);
  return d.length >= 9 ? d.slice(-9) : '';
}

/** Mask for logs / read-back: keep the last 3 digits. */
export function maskNumber(s: string | null | undefined): string {
  const d = digitsOf(s);
  if (!d) return '';
  return '…' + d.slice(-3);
}

/** Speak a number's tail so a caller can confirm which device the code went to ("ending in one, zero, zero"). */
export function spokenTail(s: string | null | undefined, n = 3): string {
  const d = digitsOf(s);
  if (!d) return '';
  return d.slice(-n).split('').join(', ');
}

/** True for a plausible E.164 string. */
export function isE164(s: string | null | undefined): boolean {
  return /^\+[1-9]\d{9,14}$/.test(String(s ?? ''));
}
