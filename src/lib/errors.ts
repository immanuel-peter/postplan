import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hostnameFromHeader } from "./host.js";
import { isRetryableStatus, problem, sendProblem } from "./problems.js";
import type { Theme } from "./theme.js";

export function statusTitle(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? "Internal Server Error" : "Bad Request");
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  // postgres.js
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/**
 * True when the error means Postgres or Garage could not be reached (or answered with its own 5xx),
 * as opposed to a bug in Postplan. Those surface as 503 so clients and visitors know to retry.
 */
export function isDependencyUnavailable(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) {
    return false;
  }
  const e = error as {
    code?: unknown;
    name?: unknown;
    cause?: unknown;
    errors?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) {
    return true;
  }
  if (e.name === "TimeoutError") {
    return true;
  }
  const s3Status = e.$metadata?.httpStatusCode;
  if (typeof s3Status === "number" && s3Status >= 500) {
    return true;
  }
  if (Array.isArray(e.errors) && e.errors.some((inner) => isDependencyUnavailable(inner, depth + 1))) {
    return true;
  }
  return isDependencyUnavailable(e.cause, depth + 1);
}

export function errorStatus(error: unknown): number {
  if (isDependencyUnavailable(error)) {
    return 503;
  }
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    return status;
  }
  return 500;
}

/** Safe, fixed copy for server-side failures: never the exception message. */
function serverDetail(status: number): string {
  if (status === 503) {
    return "A service Postplan depends on is temporarily unavailable. Nothing was lost; retry shortly.";
  }
  return "Postplan hit an unexpected error. It has been logged, and retrying usually works.";
}

type Surface = "draft" | "assets" | "dashboard";

function surfaceOf(request: FastifyRequest): Surface {
  switch (request.hostKind?.kind) {
    case "draft":
      return "draft";
    case "assets":
      return "assets";
    default:
      return "dashboard";
  }
}

export function pageTitle(status: number, surface: Surface): string {
  if (status === 404) {
    switch (surface) {
      case "draft":
        return "Oops, nothing is published here";
      case "assets":
        return "Oops, there is no file here";
      case "dashboard":
        return "Oops, this page doesn’t exist";
    }
  }
  if (status === 410) {
    return "Oops, this Draft was taken down";
  }
  if (status === 503) {
    return "Oops, Postplan is briefly unavailable";
  }
  if (status >= 500) {
    return "Oops, something broke on our end";
  }
  return "Oops, that request didn’t work";
}

function path(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? "/";
}

/**
 * HTML for browsers on the page hosts; problem+json for the API, and for anyone who asks for JSON
 * over HTML. `curl` (`*\/*`) on a page host still gets the page, as it did before.
 */
export function wantsHtml(request: FastifyRequest): boolean {
  const p = path(request);
  if (p.startsWith("/api/") || p === "/api" || p === "/openapi.json") {
    return false;
  }
  const accept = (request.headers.accept ?? "").toLowerCase();
  if (accept.includes("text/html")) {
    return true;
  }
  return !/application\/(?:problem\+)?json/.test(accept);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const BACK_SCRIPT =
  'var b=document.getElementById("back");if(b&&history.length>1){b.hidden=false;b.addEventListener("click",function(){history.back()})}';
const BACK_SCRIPT_HASH = createHash("sha256").update(BACK_SCRIPT).digest("base64");

/** The page carries no user content, so it can be strict: only its own script, styles, and Plex. */
export const ERROR_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${BACK_SCRIPT_HASH}'`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const LIGHT = `color-scheme:light;--bg:#f6f5f2;--text:#1a1a1a;--muted:#6b6b6b;--line:#e4e2dc;--surface:#fff;--btn:#111;--btn-text:#fff;--focus:rgba(11,87,208,.35)`;
const DARK = `color-scheme:dark;--bg:#161513;--text:#ecebe6;--muted:#a3a097;--line:#2e2c29;--surface:#1d1c1a;--btn:#ecebe6;--btn-text:#161513;--focus:rgba(138,180,248,.45)`;

const STYLES = `:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.page{min-height:100%;display:flex;flex-direction:column;padding:32px 40px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;color:inherit;text-decoration:none}
.host{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,monospace;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:48px 0}
h1{margin:0;max-width:720px;font-size:40px;line-height:1.15;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
.actions{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:32px}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:8px;font:inherit;font-size:14px;font-weight:500;text-decoration:none;cursor:pointer}
.btn-primary{border:0;background:var(--btn);color:var(--btn-text)}
.btn-secondary{border:1px solid var(--line);background:var(--surface);color:var(--text)}
.btn:hover{opacity:.88}
.btn:focus-visible,.brand:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
[hidden]{display:none!important}
@media (max-width:600px){.page{padding:20px 16px}h1{font-size:30px}}`;

const LOGO =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

export type ErrorPageInput = {
  status: number;
  surface: Surface;
  host: string;
  requestId: string;
  theme: Theme;
};

/**
 * Self-contained error page, matching the "Quiet" design: brand and host, one headline, and only
 * the actions that can help. "Try again" reloads the same URL; "Go back" appears only with history.
 */
export function renderErrorPage(input: ErrorPageInput): string {
  const title = pageTitle(input.status, input.surface);
  const themeAttr = input.theme === "light" || input.theme === "dark" ? ` data-theme="${input.theme}"` : "";
  const brandInner = `${LOGO}<span>Postplan</span>`;
  const brand =
    input.surface === "dashboard"
      ? `<a class="brand" href="/">${brandInner}</a>`
      : `<div class="brand">${brandInner}</div>`;
  const retry = isRetryableStatus(input.status) ? `<a class="btn btn-primary" href="">Try again</a>` : "";
  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="postplan-request-id" content="${escapeHtml(input.requestId)}">
<title>${input.status} ${escapeHtml(statusTitle(input.status))} · Postplan</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap">
<style>${STYLES}</style>
</head>
<body>
<div class="page">
<header>${brand}<span class="host">${escapeHtml(input.host)}</span></header>
<main>
<h1>${escapeHtml(title)}</h1>
<div class="actions">${retry}<button type="button" class="btn btn-secondary" id="back" hidden>Go back</button></div>
</main>
</div>
<script>${BACK_SCRIPT}</script>
</body>
</html>
`;
}

export type SendErrorOptions = {
  /** Client-facing detail for the JSON body; 5xx always use fixed copy. */
  detail?: string;
};

/** Answers with the error page or problem+json, whichever the request wants. */
export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  options: SendErrorOptions = {},
): FastifyReply {
  // A route may have set these for the success it expected before failing.
  reply.removeHeader("ETag");
  reply.removeHeader("Content-Disposition");
  reply.header("Cache-Control", "no-store");
  if (status === 503) {
    reply.header("Retry-After", "30");
  }
  if (!wantsHtml(request)) {
    const detail = status >= 500 ? serverDetail(status) : (options.detail ?? defaultClientDetail(status));
    return sendProblem(reply, problem(status, statusTitle(status), detail));
  }
  const theme = (reply.locals?.theme as Theme | undefined) ?? "system";
  const html = renderErrorPage({
    status,
    surface: surfaceOf(request),
    host: hostnameFromHeader(request.headers.host),
    requestId: request.id,
    theme,
  });
  return reply
    .code(status)
    .header("Content-Security-Policy", ERROR_PAGE_CSP)
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .type("text/html; charset=utf-8")
    .send(html);
}

function defaultClientDetail(status: number): string {
  if (status === 404) {
    return "Nothing is served at this path.";
  }
  if (status === 410) {
    return "This Draft was deleted.";
  }
  return statusTitle(status);
}

/** Replaces Fastify's default `{statusCode,error,message}` JSON for every host and route. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = errorStatus(error);
    if (status >= 500) {
      request.log.error({ err: error, statusCode: status }, error.message);
    } else {
      request.log.info({ err: error, statusCode: status }, error.message);
    }
    const headers = (error as { headers?: unknown }).headers;
    if (status < 500 && typeof headers === "object" && headers !== null) {
      reply.headers(headers as Record<string, string>);
    }
    return sendError(request, reply, status, { detail: error.message });
  });

  app.setNotFoundHandler((request, reply) => sendError(request, reply, 404));
}
