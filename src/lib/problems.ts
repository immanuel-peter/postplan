import type { FastifyReply } from "fastify";

/** RFC 9457 problem details, plus Postplan's `requestId`, `retryable`, and `currentVersion`. */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId?: string;
  retryable?: boolean;
  currentVersion?: number;
};

/** Retries help for these: the same request can succeed once the server or a dependency recovers. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501 && status !== 505);
}

/** Fills `instance`, `requestId`, and `retryable` from the request, so call sites only name the error. */
export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  const { currentVersion, ...rest } = problem;
  const body: Problem = {
    ...rest,
    instance: problem.instance ?? reply.request.url.split("?")[0] ?? "/",
    requestId: problem.requestId ?? reply.request.id,
    retryable: problem.retryable ?? isRetryableStatus(problem.status),
    ...(currentVersion === undefined ? {} : { currentVersion }),
  };
  return reply
    .code(problem.status)
    .type("application/problem+json")
    .send(body);
}

export function problem(status: number, title: string, detail: string, extra: Partial<Problem> = {}): Problem {
  return {
    type: "about:blank",
    title,
    status,
    detail,
    ...extra,
  };
}
