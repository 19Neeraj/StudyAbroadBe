/**
 * Allowed document types, checked against the file's magic bytes rather than the
 * client-supplied MIME type or extension (spec §41 file type validation).
 */
export const ALLOWED_TYPES: Record<string, { ext: string; sniff: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: 'pdf', sniff: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/jpeg': { ext: 'jpg', sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', sniff: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', sniff: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  'application/msword': { ext: 'doc', sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
};

/** Detects the real type from content; returns null when it isn't an allowed type. */
export function detectFileType(buf: Buffer): string | null {
  for (const [mime, t] of Object.entries(ALLOWED_TYPES)) if (t.sniff(buf)) return mime;
  return null;
}

/** Safe display name: no paths, control characters or quotes; keeps a short readable name. */
export function safeFileName(name: string, ext: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'document';
  const clean = base.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 80) || 'document';
  return `${clean}.${ext}`;
}
