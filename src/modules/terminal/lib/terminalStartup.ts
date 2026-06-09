const DEFAULT_RENDERER_READY_TIMEOUT_MS = 1000;

export type TerminalStartupOptions = {
  timeoutMs?: number;
  log?: (message: string) => void;
};

export async function startTerminalBeforeRendererReady(
  startPty: () => void,
  rendererReady: Promise<void>,
  bindRenderer: () => void,
  options: TerminalStartupOptions = {},
): Promise<void> {
  startPty();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDERER_READY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    rendererReady.then(
      () => "ready" as const,
      () => "failed" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  if (result === "timeout") {
    options.log?.(`terminal renderer readiness timed out after ${timeoutMs}ms`);
  } else if (result === "failed") {
    options.log?.("terminal renderer readiness failed");
  }
  bindRenderer();
}
