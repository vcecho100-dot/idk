import { AppErrorSchema, type ErrorCode } from "./types";

/** An engine error with a friendly message and a next step for the user. */
export class BackendError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.hint = hint;
  }

  static from(err: unknown): BackendError {
    if (err instanceof BackendError) return err;
    const parsed = AppErrorSchema.safeParse(err);
    if (parsed.success) return new BackendError(parsed.data.code, parsed.data.message, parsed.data.hint);
    if (err instanceof DOMException && err.name === "AbortError") {
      return new BackendError("cancelled", "Cancelled.");
    }
    if (err instanceof Error) return new BackendError("internal", err.message, "Try again. If it keeps happening, restart Shift3D.");
    if (typeof err === "string") return new BackendError("internal", err);
    return new BackendError("internal", "Something went wrong.", "Try again.");
  }
}

export function errorMessage(err: unknown): { title: string; description?: string } {
  const e = BackendError.from(err);
  return { title: e.message, description: e.hint };
}
