import readline from "node:readline";

export function runNovaProvider(handlers) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  let queue = Promise.resolve();

  input.on("line", line => {
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        console.error(`Invalid JSONL input: ${error.message}`);
        return;
      }
      if (message.type === "initialize") {
        await handlers.initialize?.(message);
        return;
      }
      if (message.type === "shutdown") {
        await handlers.shutdown?.();
        process.exit(0);
      }
      if (message.type !== "tick") return;
      try {
        const result = await handlers.tick?.(message) ?? {};
        send({
          type: "result",
          requestId: message.requestId,
          variables: result.variables ?? {},
          renders: result.renders ?? [],
          events: result.events ?? [],
        });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }).catch(error => console.error(error instanceof Error ? error.stack : String(error)));
  });
}
