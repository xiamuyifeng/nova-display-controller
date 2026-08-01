import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function pixelsFor(render, timeMs) {
  const width = Math.max(1, Number(render.width) || 1);
  const height = Math.max(1, Number(render.height) || 1);
  const columns = Math.max(2, Math.min(24, Math.round(Number(render.settings?.columns) || 8)));
  const pixels = [];
  for (let column = 0; column < columns; column += 1) {
    const start = Math.floor(column * width / columns);
    const end = Math.max(start + 1, Math.floor((column + 1) * width / columns) - 1);
    const level = Math.max(1, Math.round((Math.sin(timeMs / 450 + column) * 0.5 + 0.5) * height));
    for (let x = start; x < end; x += 1) {
      for (let y = height - level; y < height; y += 1) pixels.push(y * width + x);
    }
  }
  return pixels;
}

lines.on("line", line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error(`Invalid JSON: ${error.message}`);
    return;
  }
  if (message.type === "shutdown") {
    process.exit(0);
  }
  if (message.type !== "tick") return;
  const timeMs = Number(message.context?.timeMs) || Date.now();
  const result = {
    type: "result",
    requestId: message.requestId,
    variables: { counter: Math.floor(timeMs / 1000) % 1000 },
    renders: (message.renders ?? []).map(render => ({ id: render.id, pixels: pixelsFor(render, timeMs) })),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
