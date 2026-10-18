import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { R2Storage } from './r2';

const config = {
  accountId: 'test-account',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  bucketName: 'private-test',
};
const send = vi.spyOn(S3Client.prototype, 'send');
afterEach(() => send.mockReset());

describe('R2 storage adapter', () => {
  it('writes bytes with a private bucket and content type', async () => {
    send.mockResolvedValueOnce({} as never);
    await new R2Storage(config).put(
      'files/a.blob',
      new Uint8Array([1, 2]),
      'application/pdf',
    );
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: config.bucketName,
      Key: 'files/a.blob',
      ContentType: 'application/pdf',
    });
    expect((command.input as { Body?: unknown }).Body).toEqual(
      new Uint8Array([1, 2]),
    );
  });

  it('keeps writes, reads and deletes inside the configured app folder', async () => {
    send.mockResolvedValueOnce({} as never);
    send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([1]) },
    } as never);
    send.mockResolvedValueOnce({} as never);
    const storage = new R2Storage({
      ...config,
      keyPrefix: 'career-workspace/',
    });
    await storage.put('files/a.blob', new Uint8Array([1]), 'application/pdf');
    await storage.get('files/a.blob');
    await storage.delete('files/a.blob');
    expect(
      send.mock.calls.map(
        ([command]) => (command.input as { Key: string }).Key,
      ),
    ).toEqual([
      'career-workspace/files/a.blob',
      'career-workspace/files/a.blob',
      'career-workspace/files/a.blob',
    ]);
  });

  it('reads bytes and returns null for a missing key', async () => {
    send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([3, 4]) },
    } as never);
    expect(await new R2Storage(config).get('files/a.blob')).toEqual(
      new Uint8Array([3, 4]),
    );
    send.mockRejectedValueOnce(
      Object.assign(new NoSuchKey({ message: 'missing', $metadata: {} }), {
        name: 'NoSuchKey',
      }),
    );
    expect(await new R2Storage(config).get('files/missing.blob')).toBeNull();
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
  });

  it('deletes the requested key and propagates provider failures', async () => {
    send.mockResolvedValueOnce({} as never);
    await new R2Storage(config).delete('files/a.blob');
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    send.mockRejectedValueOnce(new Error('provider failure'));
    await expect(new R2Storage(config).get('files/a.blob')).rejects.toThrow(
      'provider failure',
    );
  });
});
