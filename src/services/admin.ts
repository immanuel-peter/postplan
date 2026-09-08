import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { adminChallenges, adminCredentials, adminSessions, adminSetup } from "../db/schema.js";
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, newSecret } from "../lib/admin-auth.js";
import { newId } from "../lib/ids.js";
import { hashToken, hashesEqual } from "../lib/tokens.js";

const SETUP_ROW = "singleton";
const LAST_SEEN_THROTTLE_MS = 60_000;

export type ChallengeOperation =
  | "authenticate"
  | "register_setup"
  | "register_recovery"
  | "register_add";

export type CredentialRecord = {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export type SessionRecord = {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
};

export type NewCredential = {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
};

export type SetupState = {
  closed: boolean;
  recoveryConsumedHash: string | null;
};

function toCredential(row: typeof adminCredentials.$inferSelect): CredentialRecord {
  return {
    id: row.id,
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    counter: row.counter,
    transports: row.transports,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export async function setupState(db: Database): Promise<SetupState> {
  const [row] = await db.select().from(adminSetup).where(eq(adminSetup.id, SETUP_ROW)).limit(1);
  if (!row) {
    return { closed: false, recoveryConsumedHash: null };
  }
  return { closed: true, recoveryConsumedHash: row.recoveryConsumedHash };
}

export async function listCredentials(db: Database): Promise<CredentialRecord[]> {
  const rows = await db.select().from(adminCredentials).orderBy(adminCredentials.createdAt);
  return rows.map(toCredential);
}

export async function findCredential(
  db: Database,
  credentialId: string,
): Promise<CredentialRecord | null> {
  const [row] = await db
    .select()
    .from(adminCredentials)
    .where(eq(adminCredentials.credentialId, credentialId))
    .limit(1);
  return row ? toCredential(row) : null;
}

export async function addCredential(db: Database, input: NewCredential): Promise<CredentialRecord> {
  const row = {
    id: newId(),
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    counter: input.counter,
    transports: input.transports,
    name: input.name,
    createdAt: new Date(),
    lastUsedAt: null,
  };
  await db.insert(adminCredentials).values(row);
  return toCredential(row);
}

export async function removeCredential(db: Database, id: string): Promise<boolean> {
  const removed = await db
    .delete(adminCredentials)
    .where(eq(adminCredentials.id, id))
    .returning({ id: adminCredentials.id });
  return removed.length > 0;
}

export async function markCredentialUsed(
  db: Database,
  id: string,
  counter: number,
): Promise<void> {
  await db
    .update(adminCredentials)
    .set({ counter, lastUsedAt: new Date() })
    .where(eq(adminCredentials.id, id));
}

/**
 * First enrollment closes setup in the same transaction that stores the credential, so two browsers
 * racing through `/setup` cannot both enroll. Removing every passkey later never reopens setup.
 */
export async function enrollFirstCredential(
  db: Database,
  input: NewCredential,
): Promise<CredentialRecord | null> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(adminSetup)
      .values({ id: SETUP_ROW, closedAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: adminSetup.id });
    if (claimed.length === 0) {
      return null;
    }
    const row = {
      id: newId(),
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      transports: input.transports,
      name: input.name,
      createdAt: new Date(),
      lastUsedAt: null,
    };
    await tx.insert(adminCredentials).values(row);
    return toCredential(row);
  });
}

/**
 * A recovery secret authorizes exactly one replacement enrollment: it wipes every credential and
 * session, then records its own hash so the same secret cannot be replayed without rotating it.
 */
export async function enrollRecoveryCredential(
  db: Database,
  input: NewCredential & { pepper: string; recoverySecret: string },
): Promise<CredentialRecord | null> {
  const hash = hashToken(input.recoverySecret, input.pepper);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(adminSetup)
      .where(eq(adminSetup.id, SETUP_ROW))
      .limit(1)
      .for("update");
    if (!row) {
      return null;
    }
    if (row.recoveryConsumedHash !== null && hashesEqual(row.recoveryConsumedHash, hash)) {
      return null;
    }
    await tx.delete(adminCredentials);
    await tx.update(adminSessions).set({ revokedAt: new Date() }).where(isNull(adminSessions.revokedAt));
    const credential = {
      id: newId(),
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      transports: input.transports,
      name: input.name,
      createdAt: new Date(),
      lastUsedAt: null,
    };
    await tx.insert(adminCredentials).values(credential);
    await tx
      .update(adminSetup)
      .set({ recoveryConsumedHash: hash, recoveryConsumedAt: new Date() })
      .where(eq(adminSetup.id, SETUP_ROW));
    return toCredential(credential);
  });
}

export async function createChallenge(
  db: Database,
  operation: ChallengeOperation,
  challenge: string,
): Promise<string> {
  const now = new Date();
  const id = newSecret();
  await db.delete(adminChallenges).where(lt(adminChallenges.expiresAt, now));
  await db.insert(adminChallenges).values({
    id,
    challenge,
    operation,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });
  return id;
}

/** Deleting on read makes a challenge single-use, so a captured response cannot be replayed. */
export async function consumeChallenge(
  db: Database,
  id: string,
  operation: ChallengeOperation,
): Promise<string | null> {
  const [row] = await db
    .delete(adminChallenges)
    .where(
      and(
        eq(adminChallenges.id, id),
        eq(adminChallenges.operation, operation),
        gt(adminChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ challenge: adminChallenges.challenge });
  return row?.challenge ?? null;
}

export async function createSession(input: {
  db: Database;
  pepper: string;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = newSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await input.db.insert(adminSessions).values({
    id: newId(),
    tokenHash: hashToken(token, input.pepper),
    userAgent: input.userAgent,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    revokedAt: null,
  });
  return { token, expiresAt };
}

export async function authenticateSession(input: {
  db: Database;
  pepper: string;
  token: string;
}): Promise<SessionRecord | null> {
  const now = new Date();
  const [row] = await input.db
    .select()
    .from(adminSessions)
    .where(
      and(
        eq(adminSessions.tokenHash, hashToken(input.token, input.pepper)),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const last = row.lastSeenAt?.getTime() ?? 0;
  if (now.getTime() - last > LAST_SEEN_THROTTLE_MS) {
    await input.db.update(adminSessions).set({ lastSeenAt: now }).where(eq(adminSessions.id, row.id));
  }
  return {
    id: row.id,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: now,
  };
}

export async function listSessions(db: Database): Promise<SessionRecord[]> {
  const rows = await db
    .select()
    .from(adminSessions)
    .where(and(isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, new Date())))
    .orderBy(adminSessions.createdAt);
  return rows.map((row) => ({
    id: row.id,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
  }));
}

export async function revokeSession(db: Database, id: string): Promise<boolean> {
  const revoked = await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt)))
    .returning({ id: adminSessions.id });
  return revoked.length > 0;
}

export async function revokeAllSessions(db: Database): Promise<void> {
  await db.update(adminSessions).set({ revokedAt: new Date() }).where(isNull(adminSessions.revokedAt));
}

export async function credentialCount(db: Database): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(adminCredentials);
  return Number(row?.count ?? 0);
}
