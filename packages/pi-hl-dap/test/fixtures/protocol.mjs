import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * @template {import("typebox").TSchema} Arguments
 * @param {Arguments} argumentsSchema
 */
export function fixtureMessageSchema(argumentsSchema) {
  return Type.Union([
    Type.Object({
      seq: Type.Number(),
      type: Type.Literal("request"),
      command: Type.String(),
      arguments: Type.Optional(argumentsSchema),
    }),
    Type.Object({
      seq: Type.Number(),
      type: Type.Literal("response"),
      request_seq: Type.Number(),
      success: Type.Boolean(),
      command: Type.String(),
      body: Type.Optional(Type.Unknown()),
      message: Type.Optional(Type.String()),
    }),
  ]);
}

/**
 * @template {import("typebox").TSchema} Schema
 * @param {Schema} schema
 * @param {string} text
 */
export function parseFixtureMessage(schema, text) {
  /** @type {unknown} */
  const message = JSON.parse(text);
  if (!Value.Check(schema, message)) throw new Error("fixture received invalid DAP message");
  return message;
}
