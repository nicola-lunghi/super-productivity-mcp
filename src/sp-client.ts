import { z } from 'zod/v4';

import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import type { Logger } from './logger.js';
import {
  SpCurrentTaskIdSchema,
  SpEnvelopeSchema,
  SpHealthSchema,
  SpProjectSchema,
  SpTagSchema,
  SpTaskSchema,
  type SpCurrentTaskId,
  type SpHealth,
  type SpProject,
  type SpTag,
  type SpTask,
} from './types.js';

export type TaskSource = 'active' | 'archived' | 'all';

export interface ListTasksOptions {
  readonly query?: string;
  readonly projectId?: string;
  readonly tagId?: string;
  readonly includeDone?: boolean;
  readonly source?: TaskSource;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly notes?: string;
  readonly projectId?: string;
}

export interface UpdateTaskInput {
  readonly isDone?: boolean;
  readonly dueDay?: string | null;
  readonly dueWithTime?: number | null;
}

type FetchLike = typeof fetch;

const parseResponseJson = async (response: Response): Promise<unknown> => {
  const body = await response.text();
  if (!body.trim()) {
    throw new AppError(
      'SP_INVALID_RESPONSE',
      `Super Productivity returned an empty response (HTTP ${response.status})`,
      {
        status: response.status,
      },
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AppError(
      'SP_INVALID_RESPONSE',
      `Super Productivity returned invalid JSON (HTTP ${response.status})`,
      {
        status: response.status,
      },
    );
  }
};

const taskIdPath = (taskId: string, suffix = '') => `/tasks/${encodeURIComponent(taskId)}${suffix}`;

const withTitleQuery = (path: string, query?: string) =>
  query ? `${path}?${new URLSearchParams({ query }).toString()}` : path;

export class SuperProductivityClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async health(): Promise<SpHealth> {
    return this.request('/health', SpHealthSchema, { requiresAuth: false });
  }

  async listTasks(options: ListTasksOptions = {}): Promise<SpTask[]> {
    const params = new URLSearchParams();
    if (options.query) params.set('query', options.query);
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.tagId) params.set('tagId', options.tagId);
    params.set('includeDone', String(options.includeDone ?? false));
    params.set('source', options.source ?? 'active');
    return this.request(`/tasks?${params.toString()}`, z.array(SpTaskSchema));
  }

  async listProjects(query?: string): Promise<SpProject[]> {
    return this.request(withTitleQuery('/projects', query), z.array(SpProjectSchema));
  }

  async listTags(query?: string): Promise<SpTag[]> {
    return this.request(withTitleQuery('/tags', query), z.array(SpTagSchema));
  }

  async getTask(taskId: string): Promise<SpTask> {
    return this.request(taskIdPath(taskId), SpTaskSchema);
  }

  async createTask(input: CreateTaskInput): Promise<SpTask> {
    return this.request('/tasks', SpTaskSchema, {
      method: 'POST',
      body: {
        title: input.title,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
    });
  }

  async updateTask(taskId: string, input: UpdateTaskInput): Promise<SpTask> {
    return this.request(taskIdPath(taskId), SpTaskSchema, {
      method: 'PATCH',
      body: input,
    });
  }

  async startTask(taskId: string): Promise<SpCurrentTaskId> {
    return this.request(taskIdPath(taskId, '/start'), SpCurrentTaskIdSchema, { method: 'POST' });
  }

  async stopTimer(): Promise<SpCurrentTaskId> {
    return this.request('/task-control/stop', SpCurrentTaskIdSchema, { method: 'POST' });
  }

  async getCurrentTask(): Promise<SpTask | null> {
    return this.request('/task-control/current', z.union([SpTaskSchema, z.null()]));
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      readonly method?: 'GET' | 'POST' | 'PATCH';
      readonly body?: unknown;
      readonly requiresAuth?: boolean;
    } = {},
  ): Promise<T> {
    const requiresAuth = options.requiresAuth ?? true;
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    // Super Productivity 18.16.0 exposes the released local API without
    // authentication. Newer builds may expose a Bearer token; send it when
    // configured while remaining compatible with the released API.
    const bearerToken = requiresAuth ? this.config.apiToken : undefined;
    if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);

    const url = `${this.config.apiUrl.toString().replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.apiTimeoutMs);
    const startedAt = Date.now();

    try {
      this.logger.debug('Calling Super Productivity API', {
        method: options.method ?? 'GET',
        path: path.split('?')[0],
        authenticated: Boolean(bearerToken),
      });

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AppError(
            'SP_TIMEOUT',
            `Super Productivity did not respond within ${this.config.apiTimeoutMs}ms`,
          );
        }
        throw new AppError(
          'SP_UNREACHABLE',
          'Could not reach Super Productivity on the configured local API URL',
          {
            details: error instanceof Error ? error.message : undefined,
          },
        );
      }

      const json = await parseResponseJson(response);
      const envelope = SpEnvelopeSchema.safeParse(json);
      if (!envelope.success) {
        throw new AppError(
          'SP_INVALID_RESPONSE',
          `Super Productivity returned an unexpected response (HTTP ${response.status})`,
          {
            status: response.status,
          },
        );
      }
      if (!response.ok || !envelope.data.ok) {
        if (envelope.data.ok) {
          throw new AppError(
            'SP_HTTP_ERROR',
            `Super Productivity returned HTTP ${response.status}`,
            {
              status: response.status,
            },
          );
        }
        throw new AppError(envelope.data.error.code, envelope.data.error.message, {
          status: response.status,
          details: envelope.data.error.details,
        });
      }

      const parsed = schema.safeParse(envelope.data.data);
      if (!parsed.success) {
        throw new AppError(
          'SP_INVALID_RESPONSE',
          'Super Productivity returned data with an unexpected shape',
          {
            status: response.status,
          },
        );
      }

      this.logger.debug('Super Productivity API call completed', {
        method: options.method ?? 'GET',
        path: path.split('?')[0],
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
