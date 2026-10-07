import type { AppConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { SpTaskSchema, type SpTask } from '../src/types.js';

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  apiUrl: new URL('http://127.0.0.1:3876'),
  apiToken: 'test-token',
  apiTimeoutMs: 1_000,
  allowNonLoopbackUrl: false,
  literalTitles: false,
  enableDelete: false,
  logLevel: 'error',
  ...overrides,
});

export const testLogger = (): Logger => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
});

export const testTask = (overrides: Record<string, unknown> = {}): SpTask =>
  SpTaskSchema.parse({
    id: 'task-1',
    title: 'Example task',
    isDone: false,
    projectId: null,
    tagIds: [],
    notes: null,
    dueDay: null,
    dueWithTime: null,
    timeEstimate: 0,
    timeSpent: 0,
    parentId: null,
    subTaskIds: [],
    ...overrides,
  });

export const successResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const errorResponse = (
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): Response =>
  new Response(
    JSON.stringify({
      ok: false,
      error: { code, message, ...(details === undefined ? {} : { details }) },
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );

export const responseText = (result: { content?: readonly unknown[] }): string => {
  const first = result.content?.[0];
  if (!first || typeof first !== 'object' || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('Expected an MCP text content block');
  }
  return first.text;
};
