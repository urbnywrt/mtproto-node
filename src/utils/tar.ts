export interface TarEntry {
  name: string;
  content: string | Buffer;
  /** Octal file mode, e.g. 0o600 for private keys. Defaults to 0o644. */
  mode?: number;
}

function writeHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512);

  header.write(entry.name, 0, 100);
  header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  // Checksum is computed with this field filled with spaces, then written over it.
  header.write('        ', 148, 8);
  header.write('0', 156, 1);

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  return header;
}

/**
 * Build an uncompressed tar archive in memory, for dockerode's putArchive.
 *
 * The single-file equivalent is duplicated in docker.ts and nginx.ts; this multi-file
 * version exists because certificates ship as a key/chain pair with different modes.
 */
export function createTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf-8');
    chunks.push(writeHeader(entry, content.length));
    chunks.push(content);
    const remainder = content.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
  }

  // Two zero blocks terminate the archive.
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
