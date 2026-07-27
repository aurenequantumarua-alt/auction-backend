import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

export interface StoredFile {
  url: string;
  key: string;
}

export interface Storage {
  put(buffer: Buffer, originalName: string, mimeType: string): Promise<StoredFile>;
}

class LocalStorage implements Storage {
  private readonly root = resolve(env.UPLOADS_DIR);

  async put(buffer: Buffer, originalName: string, _mimeType: string): Promise<StoredFile> {
    if (!existsSync(this.root)) {
      await mkdir(this.root, { recursive: true });
    }
    const ext = extname(originalName) || '.bin';
    const key = `${randomUUID()}${ext}`;
    const filePath = join(this.root, key);
    await writeFile(filePath, buffer);
    return {
      key,
      url: `${env.PUBLIC_UPLOADS_BASE_URL.replace(/\/$/, '')}/${key}`,
    };
  }
}

class S3Storage implements Storage {
  async put(_buffer: Buffer, _originalName: string, _mimeType: string): Promise<StoredFile> {
    throw new Error('S3 storage driver is not implemented yet — install @aws-sdk/client-s3 and wire it up here.');
  }
}

export const storage: Storage = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
