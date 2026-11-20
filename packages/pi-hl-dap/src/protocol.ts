import { Type } from "typebox";

export const DapAdapterProtocolIdSchema = Type.String({ minLength: 1 });
export const DapCapabilitiesSchema = Type.Object(
  {
    supportsConfigurationDoneRequest: Type.Optional(Type.Boolean()),
    supportsTerminateRequest: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
export const DapOutputEventBodySchema = Type.Object(
  { output: Type.String(), category: Type.Optional(Type.String()) },
  { additionalProperties: true },
);
export const DapStoppedEventBodySchema = Type.Object(
  {
    reason: Type.String(),
    description: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Integer()),
    hitBreakpointIds: Type.Optional(Type.Array(Type.Integer())),
  },
  { additionalProperties: true },
);
export const DapContinuedEventBodySchema = Type.Object(
  { threadId: Type.Optional(Type.Integer()) },
  { additionalProperties: true },
);
export const DapExitedEventBodySchema = Type.Object(
  { exitCode: Type.Integer() },
  { additionalProperties: true },
);
export const DapSourceSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export const DapBreakpointSchema = Type.Object(
  {
    id: Type.Optional(Type.Integer()),
    verified: Type.Boolean(),
    message: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer()),
    column: Type.Optional(Type.Integer()),
    source: Type.Optional(DapSourceSchema),
  },
  { additionalProperties: true },
);
export const DapSetBreakpointsBodySchema = Type.Object(
  { breakpoints: Type.Array(DapBreakpointSchema) },
  { additionalProperties: true },
);
export const DapThreadSchema = Type.Object(
  { id: Type.Integer(), name: Type.String() },
  { additionalProperties: true },
);
export const DapThreadsBodySchema = Type.Object(
  { threads: Type.Array(DapThreadSchema) },
  { additionalProperties: true },
);
export const DapStackFrameSchema = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    line: Type.Integer(),
    column: Type.Integer(),
    source: Type.Optional(DapSourceSchema),
  },
  { additionalProperties: true },
);
export const DapStackTraceBodySchema = Type.Object(
  {
    stackFrames: Type.Array(DapStackFrameSchema),
    totalFrames: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);
export const DapScopeSchema = Type.Object(
  {
    name: Type.String(),
    variablesReference: Type.Integer({ minimum: 0 }),
    expensive: Type.Boolean(),
    namedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    indexedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);
export const DapScopesBodySchema = Type.Object(
  { scopes: Type.Array(DapScopeSchema) },
  { additionalProperties: true },
);
export const DapVariableSchema = Type.Object(
  {
    name: Type.String(),
    value: Type.String(),
    variablesReference: Type.Integer({ minimum: 0 }),
    type: Type.Optional(Type.String()),
    evaluateName: Type.Optional(Type.String()),
    namedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    indexedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    memoryReference: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export const DapVariablesBodySchema = Type.Object(
  { variables: Type.Array(DapVariableSchema) },
  { additionalProperties: true },
);
export const DapEvaluateBodySchema = Type.Object(
  {
    result: Type.String(),
    variablesReference: Type.Integer({ minimum: 0 }),
    type: Type.Optional(Type.String()),
    namedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    indexedVariables: Type.Optional(Type.Integer({ minimum: 0 })),
    memoryReference: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export const RunInTerminalArgumentsSchema = Type.Object(
  {
    args: Type.Array(Type.String(), { minItems: 1 }),
    cwd: Type.String({ minLength: 1 }),
    env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
    argsCanBeInterpretedByShell: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
/** A `startDebugging` request: `launch` or `attach` arguments for the session it asks for. */
export const StartDebuggingArgumentsSchema = Type.Object(
  {
    configuration: Type.Record(Type.String(), Type.Unknown()),
    request: Type.Union([Type.Literal("launch"), Type.Literal("attach")]),
  },
  { additionalProperties: true },
);
