import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const UPLOADS_DIR = join(process.cwd(), 'public', 'uploads');

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'video/mp4', 'video/webm',
]);

const MAX_BYTES = 10 * 1024 * 1024;

if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

export type SavedFile = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export async function saveUpload(file: File): Promise<SavedFile> {
  if (file.size === 0) throw new Error('Empty file');
  if (file.size > MAX_BYTES) throw new Error('File exceeds 10 MB limit');
  if (!ALLOWED_MIME.has(file.type)) throw new Error(`Unsupported file type: ${file.type}`);

  const ext = extname(file.name) || '';
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  const filename = `${randomUUID()}${safeExt}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(join(UPLOADS_DIR, filename), buffer);
  return { filename, mimeType: file.type, sizeBytes: file.size };
}

export async function deleteUpload(filename: string) {
  try {
    await unlink(join(UPLOADS_DIR, filename));
  } catch {
    // file may already be gone — ignore
  }
}

export function publicUrl(filename: string): string {
  return `/uploads/${filename}`;
}