import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

export interface StoredFile {
  url: string;
  key: string;
}

export interface Storage {
  put(buffer: Buffer, originalName: string, mimeType: string): Promise<StoredFile>;
}

const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

class LocalStorage implements Storage {
  private readonly root = resolve(env.UPLOADS_DIR);

  async put(buffer: Buffer, _originalName: string, mimeType: string): Promise<StoredFile> {
    if (!existsSync(this.root)) {
      await mkdir(this.root, { recursive: true });
    }
    // Derive extension strictly from validated MIME type, never from user-supplied filename
    const ext = MIME_EXT_MAP[mimeType] || '.bin';
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
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor() {
    const accountId = env.R2_ACCOUNT_ID;
    const accessKeyId = env.R2_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
    this.bucket = env.R2_BUCKET_NAME || 'aurene-uploads';
    this.publicBaseUrl = (env.R2_PUBLIC_URL || '').replace(/\/$/, '');

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'Cloudflare R2 is configured as STORAGE_DRIVER but R2 credentials are missing in environment.',
      );
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async put(buffer: Buffer, _originalName: string, mimeType: string): Promise<StoredFile> {
    const ext = MIME_EXT_MAP[mimeType] || '.bin';
    const key = `auctions/${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    const url = this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : `/${key}`;
    return { key, url };
  }
}

export const storage: Storage = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
