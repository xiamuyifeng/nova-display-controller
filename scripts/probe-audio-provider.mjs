import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";

const executable = path.resolve(process.argv[2] ?? "extensions/providers/system-audio/provider.exe");
const provider = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
const output = readline.createInterface({ input: provider.stdout, crlfDelay: Infinity });
let responses = 0;
let maxRms = 0;
let maxPixels = 0;
const eventNames = new Set();

provider.stderr.on("data", data => process.stderr.write(data));
output.on("line", line => {
  const message = JSON.parse(line);
  if (message.type !== "result") return;
  responses += 1;
  maxRms = Math.max(maxRms, Number(message.variables?.rms) || 0);
  maxPixels = Math.max(maxPixels, message.renders?.[0]?.pixels?.length ?? 0);
  for (const event of message.events ?? []) eventNames.add(event.name);
});

for (let requestId = 1; requestId <= 30; requestId += 1) {
  provider.stdin.write(`${JSON.stringify({
    type: "tick",
    requestId,
    context: { timeMs: Date.now() },
    renders: [{ id: "spectrum", width: 64, height: 24, settings: { bars: 16, gain: 3, smoothing: 0.5, filled: true } }],
  })}\n`);
  await new Promise(resolve => setTimeout(resolve, 100));
}
provider.stdin.write('{"type":"shutdown"}\n');
await new Promise(resolve => provider.once("exit", resolve));
console.log(JSON.stringify({ responses, maxRms, maxPixels, events: [...eventNames] }));
