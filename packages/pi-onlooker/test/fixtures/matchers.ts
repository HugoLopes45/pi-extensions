import { expect } from "vite-plus/test";

// Vitest types its asymmetric matchers as `any`; these return `unknown` so expected objects stay typed.

export const anyInstance = (constructor: unknown): unknown => expect.any(constructor);
export const arrayContaining = (items: unknown[]): unknown => expect.arrayContaining(items);
export const objectContaining = (shape: Record<string, unknown>): unknown =>
  expect.objectContaining(shape);
export const stringContaining = (text: string): unknown => expect.stringContaining(text);
export const stringMatching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
