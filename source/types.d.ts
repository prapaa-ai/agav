declare module "marked-terminal" {
  export function markedTerminal(options?: Record<string, unknown>): unknown;
}

// pdfjs-dist ships types for its main entry only. The worker is imported for
// its side effect of being bundled, so the handler shape is all that matters.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
