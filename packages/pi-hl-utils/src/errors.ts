/** A thrown value's message, or its string form. */
export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether a thrown value is a file system error for a missing path. */
export function isMissingFileError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
