// One-shot 127.0.0.1 hop between the Playwright sandbox (no fs) and local files, so secrets and
// passkey material never appear in snippet code or tool output. Exits after one request or 60s.
//   node oneshot.mjs serve-env <VAR> <portfile>   respond with process.env[VAR]
//   node oneshot.mjs serve-file <path> <portfile> respond with the file's contents
//   node oneshot.mjs receive <path> <portfile>    write the request body to path (mode 600)
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const [mode, target, portfile] = process.argv.slice(2);
const server = createServer((req, res) => {
  if (mode === "receive") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      writeFileSync(target, Buffer.concat(chunks), { mode: 0o600 });
      res.end("ok");
      server.close();
    });
    return;
  }
  res.end(mode === "serve-env" ? process.env[target] ?? "" : readFileSync(target));
  server.close();
});
server.listen(0, "127.0.0.1", () => writeFileSync(portfile, String(server.address().port)));
setTimeout(() => process.exit(0), 60000).unref();
