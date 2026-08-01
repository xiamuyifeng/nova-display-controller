import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: npm run test:provider -- <provider-executable>");
const resolvedExecutable = path.resolve(executable);
const isWindowsScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolvedExecutable);
const child = isWindowsScript
  ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", resolvedExecutable], { stdio: ["pipe", "pipe", "pipe"] })
  : spawn(resolvedExecutable, [], { stdio: ["pipe", "pipe", "pipe"] });
const errors = [];
child.stderr.on("data", data => errors.push(String(data).trim()));
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Provider did not respond within 2 seconds")), 2000);
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type !== "result" || message.requestId !== 1) return;
    clearTimeout(timer);
    resolve(message);
  });
  child.once("exit", code => {
    if (code && code !== 0) reject(new Error(`Provider exited with ${code}: ${errors.join("\n")}`));
  });
  child.stdin.write(`${JSON.stringify({ type: "initialize", protocol: "nova-jsonl-v1", extensionId: "dev.protocol.test", host: { platform: process.platform } })}\n`);
  child.stdin.write(`${JSON.stringify({ type: "tick", requestId: 1, context: { timeMs: Date.now(), cpu: 20 }, renders: [{ id: "test-layer", width: 16, height: 8, settings: {} }] })}\n`);
});
if (!result.variables || !Array.isArray(result.renders) || !Array.isArray(result.events)) {
  throw new Error("Provider result must contain variables, renders, and events");
}
child.stdin.write('{"type":"shutdown"}\n');
await new Promise(resolve => child.once("exit", resolve));
console.log(JSON.stringify({ ok: true, variables: Object.keys(result.variables), renders: result.renders.length, events: result.events.map(event => event.name) }, null, 2));
