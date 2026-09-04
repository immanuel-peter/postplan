import type { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

export function createS3(config: AppConfig): S3Client {
  return new S3Client({
    region: config.s3Region,
    endpoint: config.s3EndpointUrl,
    forcePathStyle: config.s3AddressingStyle === "path",
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
  });
}

export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putHtml(input: {
  client: S3Client;
  bucket: string;
  objectKey: string;
  bytes: Buffer;
}): Promise<void> {
  await input.client.send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      Body: input.bytes,
      ContentType: "text/html; charset=utf-8",
    }),
  );
}

export async function getHtml(input: {
  client: S3Client;
  bucket: string;
  objectKey: string;
}): Promise<Buffer> {
  const result = await input.client.send(
    new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
    }),
  );
  if (!result.Body) {
    throw new Error(`missing body for ${input.objectKey}`);
  }
  return Buffer.from(await result.Body.transformToByteArray());
}

export async function deleteObject(input: {
  client: S3Client;
  bucket: string;
  objectKey: string;
}): Promise<void> {
  await input.client.send(
    new DeleteObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
    }),
  );
}

export function versionObjectKey(draftId: string, version: number): string {
  return `drafts/${draftId}/versions/${version}.html`;
}

export function assetObjectKey(id: string, filename: string | null): string {
  let name = filename ?? "";
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (slash >= 0) {
    name = name.slice(slash + 1);
  }
  name = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_");
  name = name.replace(/^\.+/, "");
  if (name.length === 0) {
    name = "file";
  }
  if (name.length > 180) {
    name = name.slice(0, 180);
  }
  return `assets/${id}/${name}`;
}

export async function putBytes(input: {
  client: S3Client;
  bucket: string;
  objectKey: string;
  bytes: Buffer;
  contentType: string;
}): Promise<void> {
  await input.client.send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      Body: input.bytes,
      ContentType: input.contentType,
    }),
  );
}

export async function getObjectStream(input: {
  client: S3Client;
  bucket: string;
  objectKey: string;
  range?: string | undefined;
}): Promise<{
  body: Readable;
  contentLength: number;
  contentRange: string | undefined;
}> {
  const result = await input.client.send(
    new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      Range: input.range,
    }),
  );
  if (!result.Body) {
    throw new Error(`missing body for ${input.objectKey}`);
  }
  return {
    body: result.Body as Readable,
    contentLength: result.ContentLength ?? 0,
    contentRange: result.ContentRange,
  };
}
