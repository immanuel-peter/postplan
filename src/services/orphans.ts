import { lt } from "drizzle-orm";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "../db/client.js";
import { orphanObjects } from "../db/schema.js";
import { deleteObject } from "../lib/s3.js";

const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export async function recordOrphan(db: Database, objectKey: string): Promise<void> {
  await db
    .insert(orphanObjects)
    .values({ objectKey, createdAt: new Date() })
    .onConflictDoNothing();
}

export async function cleanupOrphans(input: {
  db: Database;
  s3: S3Client;
  bucket: string;
}): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_TTL_MS);
  const rows = await input.db.select().from(orphanObjects).where(lt(orphanObjects.createdAt, cutoff));
  for (const row of rows) {
    try {
      await deleteObject({ client: input.s3, bucket: input.bucket, objectKey: row.objectKey });
    } catch {
      continue;
    }
    await input.db.delete(orphanObjects).where(lt(orphanObjects.createdAt, cutoff));
  }
}
