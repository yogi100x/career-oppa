import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { PrivateStorage } from './types';

export type R2StorageConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  keyPrefix?: string;
};

export class R2Storage implements PrivateStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: R2StorageConfig,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: 'auto',
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async put(
    key: string,
    contents: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: `${this.config.keyPrefix ?? ''}${key}`,
        Body: contents,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucketName,
          Key: `${this.config.keyPrefix ?? ''}${key}`,
        }),
      );
      if (!response.Body) return null;
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucketName,
        Key: `${this.config.keyPrefix ?? ''}${key}`,
      }),
    );
  }
}
