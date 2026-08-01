import fs from "node:fs/promises";
import path from "node:path";

const id = process.argv[2];
if (!id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(id)) {
  throw new Error("Usage: npm run create:provider -- <reverse-domain-id> [directory]");
}
const directory = path.resolve(process.argv[3] ?? `extensions/local/${id}`);
await fs.mkdir(directory, { recursive: false });
const name = id.split(/[.-]/).at(-1).replaceAll("-", " ").replace(/\b\w/g, value => value.toUpperCase());
const manifest = {
  format: "nova-display-extension",
  apiVersion: 2,
  runtime: "provider",
  id,
  name,
  version: "0.1.0",
  author: "Local developer",
  description: "Nova Display Provider",
  entry: { windows: "provider.cmd", linux: "provider" },
  files: ["provider.cmd", "provider", "provider.mjs", "nova-provider.mjs"],
  protocol: "nova-jsonl-v1",
  capabilities: ["variables", "renderer", "events"],
  variables: [{ key: "value", label: "示例数值" }],
  events: [{ key: "sample_event", label: "示例事件" }],
  renderer: {
    label: "示例图层",
    settings: [{ key: "level", label: "高度", type: "range", default: 50, min: 0, max: 100, step: 1 }],
  },
  permissions: ["native.process"],
};
const source = `import { runNovaProvider } from "./nova-provider.mjs";

let sentEvent = false;
runNovaProvider({
  tick(message) {
    const value = Math.round((Math.sin(Date.now() / 700) * 0.5 + 0.5) * 100);
    const renders = (message.renders ?? []).map(render => {
      const level = Math.round((Number(render.settings?.level) || value) / 100 * render.height);
      const pixels = [];
      for (let y = render.height - level; y < render.height; y += 1) {
        for (let x = 0; x < render.width; x += 1) pixels.push(y * render.width + x);
      }
      return { id: render.id, pixels };
    });
    const events = sentEvent ? [] : [{ name: "sample_event", data: { value } }];
    sentEvent = true;
    return { variables: { value }, renders, events };
  },
});
`;
await fs.writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(path.join(directory, "provider.mjs"), source);
await fs.writeFile(path.join(directory, "provider.cmd"), '@echo off\r\nnode "%~dp0provider.mjs"\r\n');
await fs.writeFile(path.join(directory, "provider"), '#!/bin/sh\nexec node "$(dirname "$0")/provider.mjs"\n');
await fs.copyFile(path.resolve("extensions/sdk/node/nova-provider.mjs"), path.join(directory, "nova-provider.mjs"));
console.log(directory);
