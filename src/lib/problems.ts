import type { FastifyReply } from "fastify";

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  currentVersion?: number;
};

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply
    .code(problem.status)
    .type("application/problem+json")
    .send(problem);
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
