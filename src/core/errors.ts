export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "PATH_INVALID"
  | "FORBIDDEN"
  | "TEST_NOT_CONFIGURED"
  | "GENERATION_FAILED";

/** Every failure the service layer reports. The UI and MCP tools show `message` as-is. */
export class LibraryError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

export const notFound = (what: string, ref: string) =>
  new LibraryError("NOT_FOUND", `${what} not found: "${ref}"`);

export const invalid = (message: string) => new LibraryError("VALIDATION", message);

/** Checks by shape, not instanceof: bundlers can load this module more than once. */
export function isLibraryError(err: unknown): err is LibraryError {
  return err instanceof Error && err.name === "LibraryError" && typeof (err as LibraryError).code === "string";
}
