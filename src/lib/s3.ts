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
