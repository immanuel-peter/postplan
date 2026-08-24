import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import type { Scope } from "./tokens.js";
import { authenticateToken, hasScope } from "../services/tokens.js";
import type { TokenRecord } from "../services/types.js";

export async function requireToken(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  scope: Scope,
): Promise<TokenRecord | null> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    reply.code(401).type("application/problem+json").send({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "missing bearer token",
    });
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  const record = await authenticateToken({
    db: deps.db,
    pepper: deps.config.tokenPepper,
    token,
  });
  if (!record) {
    reply.code(401).type("application/problem+json").send({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "invalid token",
    });
    return null;
  }
  if (!hasScope(record, scope)) {
    reply.code(403).type("application/problem+json").send({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: `missing scope ${scope}`,
    });
    return null;
  }
  request.apiToken = record;
  return record;
}
