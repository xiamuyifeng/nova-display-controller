import { executeExtensionSource } from "./extensionSandbox";

interface WorkerRequest {
  id: number;
  source: string;
  input: Record<string, unknown>;
  renderRequests: Array<{ id: string; width: number; height: number; settings: Record<string, unknown> }>;
}

interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

async function execute(request: WorkerRequest) {
  return executeExtensionSource(request.source, request.input, request.renderRequests);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void execute(request).then(
    result => self.postMessage({ id: request.id, result } satisfies WorkerResponse),
    error => self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse),
  );
};
