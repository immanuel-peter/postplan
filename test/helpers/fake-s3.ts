import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

type StoredObject = { bytes: Buffer; contentType: string | undefined };

/**
 * In-memory stand-in for the handful of S3 commands the app sends. Only `send` is implemented, so
 * any new command type fails loudly instead of silently passing.
 */
export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly buckets = new Set<string>();

  constructor(bucket: string) {
    this.buckets.add(bucket);
  }

  asClient(): S3Client {
    return this as unknown as S3Client;
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof HeadBucketCommand) {
      if (!this.buckets.has(command.input.Bucket ?? "")) {
        throw Object.assign(new Error("NoSuchBucket"), { name: "NotFound" });
      }
      return {};
    }
    if (command instanceof CreateBucketCommand) {
      this.buckets.add(command.input.Bucket ?? "");
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      if (!Buffer.isBuffer(body)) {
        throw new Error("FakeS3 only accepts Buffer bodies");
      }
      this.objects.set(this.key(command.input.Bucket, command.input.Key), {
        bytes: Buffer.from(body),
        contentType: command.input.ContentType,
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.objects.get(this.key(command.input.Bucket, command.input.Key));
      if (!stored) {
        throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      }
      const { bytes, range } = slice(stored.bytes, command.input.Range);
      const body = Object.assign(Readable.from([bytes]), {
        transformToByteArray: async () => new Uint8Array(bytes),
      });
      return {
        Body: body,
        ContentLength: bytes.byteLength,
        ContentRange: range,
        ContentType: stored.contentType,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(this.key(command.input.Bucket, command.input.Key));
      return {};
    }
    throw new Error(`FakeS3 does not implement ${(command as object).constructor.name}`);
  }

  has(bucket: string, key: string): boolean {
    return this.objects.has(this.key(bucket, key));
  }

  private key(bucket: string | undefined, key: string | undefined): string {
    return `${bucket ?? ""}/${key ?? ""}`;
  }
}

function slice(bytes: Buffer, range: string | undefined): { bytes: Buffer; range: string | undefined } {
  if (!range) {
    return { bytes, range: undefined };
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) {
    throw new Error(`FakeS3 cannot parse range ${range}`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  return {
    bytes: bytes.subarray(start, end + 1),
    range: `bytes ${start}-${end}/${bytes.byteLength}`,
  };
}
