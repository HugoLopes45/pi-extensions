import { Type } from "typebox";
import { Value } from "typebox/value";

const nodeProcessErrorProperties = Type.Object({
  code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  stderr: Type.Optional(Type.String()),
});

/**
 * @param {unknown} cause
 */
export function parseNodeProcessError(cause) {
  if (!(cause instanceof Error) || !Value.Check(nodeProcessErrorProperties, cause)) return null;
  const processError = {};
  if (cause.code !== undefined) processError.code = cause.code;
  if (cause.stderr !== undefined) processError.stderr = cause.stderr;
  return Object.keys(processError).length > 0 ? processError : null;
}

/**
 * @param {ReturnType<typeof parseNodeProcessError>} processError
 * @param {string | number} code
 */
export function hasNodeProcessErrorCode(processError, code) {
  return processError?.code === code;
}
