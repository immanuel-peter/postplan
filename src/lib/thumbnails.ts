import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

// 2x the dashboard's 52x39 thumbnail box.
export const THUMB_WIDTH = 104;
export const THUMB_HEIGHT = 78;
export const THUMB_CONTENT_TYPE = "image/webp";

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/tiff"]);
const FFMPEG_TIMEOUT_MS = 30_000;

export type Thumbnail = { bytes: Buffer; color: string };

export function canThumbnail(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return RASTER_TYPES.has(base) || base.startsWith("video/");
}

/** A small WebP preview plus its dominant colour, or null when the file can't be previewed. */
export async function makeThumbnail(bytes: Buffer, contentType: string): Promise<Thumbnail | null> {
  if (!canThumbnail(contentType)) {
    return null;
  }
  try {
    const source = contentType.toLowerCase().startsWith("video/") ? await videoFrame(bytes) : bytes;
    return source ? await fromImage(source) : null;
  } catch {
    return null;
  }
}

async function fromImage(bytes: Buffer): Promise<Thumbnail> {
  const thumb = await sharp(bytes)
    .rotate()
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: "cover" })
    .webp({ quality: 72 })
    .toBuffer();
  const { dominant } = await sharp(thumb).stats();
  const hex = [dominant.r, dominant.g, dominant.b].map((c) => c.toString(16).padStart(2, "0")).join("");
  return { bytes: thumb, color: `#${hex}` };
}

async function videoFrame(bytes: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "postplan-thumb-"));
  try {
    const input = join(dir, "video");
    await writeFile(input, bytes);
    return await new Promise<Buffer | null>((resolve) => {
      const proc = spawn(
        "ffmpeg",
        ["-v", "error", "-i", input, "-vf", "thumbnail=30", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => proc.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        const frame = Buffer.concat(chunks);
        resolve(code === 0 && frame.byteLength > 0 ? frame : null);
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
