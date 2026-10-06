import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { AppConfig } from './config.js';
import { AppError, toPublicError } from './errors.js';
import { addGithubMarker, findGithubIssueTask, parseGithubIssueRef } from './github.js';
import type { Logger } from './logger.js';
import { assertLiteralTitle } from './short-syntax.js';
import type { ListTasksOptions, SuperProductivityClient, TaskSource } from './sp-client.js';
import {
  INBOX_PROJECT_ID,
  dueAtSchema,
  dueDaySchema,
  minutesToMs,
  projectIdSchema,
  projectNameSchema,
  resolveDue,
  resolveProjectId,
  resolveTagIds,
  tagIdsSchema,
  tagNamesSchema,
  taskNotesSchema,
  taskTitleSchema,
  timeEstimateMinutesSchema,
} from './task-input.js';
import type { SpTask } from './types.js';

const MAX_TASK_ID_LENGTH = 256;
const taskIdSchema = z.string().trim().min(1).max(MAX_TASK_ID_LENGTH);
const limitSchema = z.number().int().min(1).max(100).optional().default(50);

const emptyInputSchema = z.object({}).strict();

const searchTasksInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    tagId: z.string().trim().min(1).max(256).optional(),
    includeDone: z.boolean().optional().default(false),
    source: z.enum(['active', 'archived', 'all']).optional().default('active'),
    limit: limitSchema,
  })
  .strict();

const listByTitleInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const listTodayInputSchema = z
  .object({
    includeDone: z.boolean().optional().default(false),
    limit: limitSchema,
  })
  .strict();

const taskActionInputSchema = z
  .object({
    taskId: taskIdSchema,
  })
  .strict();

const getTaskInputSchema = z
  .object({
    taskId: taskIdSchema,
    includeSubTasks: z.boolean().optional().default(false),
  })
  .strict();

const startAtSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      /T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)),
    'startAt must be an ISO-8601 timestamp with an explicit timezone offset',
  );

const planTaskTodayInputSchema = z
  .object({
    taskId: taskIdSchema,
    startAt: startAtSchema.optional(),
  })
  .strict();

const ensureGithubIssueInputSchema = z
  .object({
    issue: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().trim().max(10_000).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    planToday: z.boolean().optional().default(false),
  })
  .strict();

const createTaskInputSchema = z
  .object({
    title: taskTitleSchema,
    notes: taskNotesSchema.optional(),
    projectId: projectIdSchema.optional(),
    projectName: projectNameSchema.optional(),
    tagIds: tagIdsSchema.optional(),
    tagNames: tagNamesSchema.optional(),
    parentId: taskIdSchema.optional(),
    dueDay: dueDaySchema.optional(),
    dueAt: dueAtSchema.optional(),
    timeEstimateMinutes: timeEstimateMinutesSchema.optional(),
  })
  .strict();

const updateTaskInputSchema = z
  .object({
    taskId: taskIdSchema,
    title: taskTitleSchema.optional(),
    notes: taskNotesSchema.optional(),
    isDone: z.boolean().optional(),
    projectId: projectIdSchema.optional(),
    projectName: projectNameSchema.optional(),
    tagIds: tagIdsSchema.optional(),
    tagNames: tagNamesSchema.optional(),
    dueDay: dueDaySchema.nullable().optional(),
    dueAt: dueAtSchema.nullable().optional(),
    timeEstimateMinutes: timeEstimateMinutesSchema.optional(),
  })
  .strict();

type CreateTaskToolInput = z.infer<typeof createTaskInputSchema>;
type UpdateTaskToolInput = z.infer<typeof updateTaskInputSchema>;
type SearchTasksInput = z.infer<typeof searchTasksInputSchema>;
type ListByTitleInput = z.infer<typeof listByTitleInputSchema>;
type ListTodayInput = z.infer<typeof listTodayInputSchema>;
type TaskActionInput = z.infer<typeof taskActionInputSchema>;
type GetTaskInput = z.infer<typeof getTaskInputSchema>;
type PlanTaskTodayInput = z.infer<typeof planTaskTodayInputSchema>;
type EnsureGithubIssueInput = z.infer<typeof ensureGithubIssueInputSchema>;

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly client: SuperProductivityClient;
  readonly logger: Logger;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const STATE_CHANGE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const todayDateString = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isToday = (task: SpTask, date = new Date()): boolean => {
  if (typeof task.dueWithTime === 'number') {
    return todayDateString(new Date(task.dueWithTime)) === todayDateString(date);
  }
  return task.dueDay === todayDateString(date);
};

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly isDone: boolean;
  readonly projectId: string | null;
  readonly tagIds: readonly string[];
  readonly plannedForToday: boolean;
  readonly dueDay: string | null;
  readonly dueWithTime: number | null;
  readonly deadlineDay: string | null;
  readonly deadlineWithTime: number | null;
  readonly timeEstimate: number;
  readonly timeSpent: number;
  readonly parentId: string | null;
  readonly subTaskIds: readonly string[];
  readonly issue: {
    readonly provider: string;
    readonly id: string;
    readonly providerId: string | null;
  } | null;
}

export const summarizeTask = (task: SpTask, date = new Date()): TaskSummary => ({
  id: task.id,
  title: task.title,
  isDone: task.isDone ?? false,
  projectId: task.projectId ?? null,
  tagIds: task.tagIds ?? [],
  plannedForToday: isToday(task, date),
  dueDay: task.dueDay ?? null,
  dueWithTime: task.dueWithTime ?? null,
  deadlineDay: task.deadlineDay ?? null,
  deadlineWithTime: task.deadlineWithTime ?? null,
  timeEstimate: task.timeEstimate ?? 0,
  timeSpent: task.timeSpent ?? 0,
  parentId: task.parentId ?? null,
  subTaskIds: task.subTaskIds ?? [],
  issue:
    task.issueType && task.issueId !== undefined && task.issueId !== null
      ? {
          provider: task.issueType,
          id: String(task.issueId),
          providerId: task.issueProviderId ?? null,
        }
      : null,
});

const toolSuccess = <T extends Record<string, unknown>>(data: T) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const toolFailure = (error: unknown, logger: Logger) => {
  const publicError = toPublicError(error);
  logger.warn('MCP tool failed', {
    code: publicError.code,
    status: publicError.status,
    message: publicError.message,
  });
  const data = { error: { code: publicError.code, message: publicError.message } };
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
};

const withToolErrors = async <T extends Record<string, unknown>>(
  action: () => Promise<T>,
  logger: Logger,
) => {
  try {
    return toolSuccess(await action());
  } catch (error) {
    return toolFailure(error, logger);
  }
};

const taskListOptions = (input: SearchTasksInput): ListTasksOptions => ({
  ...(input.query ? { query: input.query } : {}),
  ...(input.projectId ? { projectId: input.projectId } : {}),
  ...(input.tagId ? { tagId: input.tagId } : {}),
  includeDone: input.includeDone,
  source: input.source as TaskSource,
});

export const createMcpServer = ({ config, client, logger }: ServerDependencies): McpServer => {
  const server = new McpServer(
    {
      name: 'super-productivity-mcp',
      version: '0.1.0',
    },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        'Every task-changing operation is explicit. Use list_projects and list_tags to resolve project and tag names to IDs. First use search_tasks or list_today to identify a task, then pass its exact taskId to plan_task_today, start_task, stop_timer, or complete_task. Do not infer or bulk-select tasks. create_task creates exactly one task per call, only when the user asks; it lands in the Inbox unless a project is given. update_task changes only the fields it is given. ensure_github_issue_task is idempotent and never plans the task unless planToday=true.',
    },
  );

  const checkConnection = () =>
    withToolErrors(async () => {
      try {
        const health = await client.health();
        const configured = health.server === 'up' && health.rendererReady;
        return {
          connected: configured,
          reachable: true,
          rendererReady: health.rendererReady,
          configured,
          tokenConfigured: Boolean(config.apiToken),
          apiUrl: config.apiUrl.toString(),
        };
      } catch (error) {
        const publicError = toPublicError(error);
        return {
          connected: false,
          reachable: false,
          rendererReady: false,
          configured: false,
          tokenConfigured: Boolean(config.apiToken),
          apiUrl: config.apiUrl.toString(),
          error: { code: publicError.code, message: publicError.message },
        };
      }
    }, logger);

  for (const name of ['health', 'check_connection'] as const) {
    server.registerTool(
      name,
      {
        title: 'Check Super Productivity connection',
        description:
          'Check whether the local Super Productivity desktop API is reachable and ready.',
        inputSchema: emptyInputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async () => checkConnection(),
    );
  }

  server.registerTool(
    'search_tasks',
    {
      title: 'Search Super Productivity tasks',
      description:
        'Find tasks by title, project, or tag. Returns task IDs for explicit follow-up actions.',
      inputSchema: searchTasksInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        const tasks = await client.listTasks(taskListOptions(input));
        const limited = tasks.slice(0, input.limit);
        return {
          tasks: limited.map((task) => summarizeTask(task)),
          totalMatches: tasks.length,
          returned: limited.length,
          truncated: tasks.length > limited.length,
        };
      }, logger),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get one task',
      description:
        'Read one task by exact ID, including its notes. Set includeSubTasks to also return its subtasks.',
      inputSchema: getTaskInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: GetTaskInput) =>
      withToolErrors(async () => {
        const task = await client.getTask(input.taskId);
        const subTasks = input.includeSubTasks
          ? await Promise.all((task.subTaskIds ?? []).map((id) => client.getTask(id)))
          : undefined;
        return {
          task: { ...summarizeTask(task), notes: task.notes ?? '' },
          ...(subTasks ? { subTasks: subTasks.map((subTask) => summarizeTask(subTask)) } : {}),
        };
      }, logger),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List Super Productivity projects',
      description:
        'List project IDs and titles, optionally filtered by a case-insensitive title substring. Use the IDs with search_tasks or ensure_github_issue_task.',
      inputSchema: listByTitleInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: ListByTitleInput) =>
      withToolErrors(async () => {
        const projects = await client.listProjects(input.query);
        return {
          projects: projects.map((project) => ({
            id: project.id,
            title: project.title,
            isArchived: project.isArchived ?? false,
          })),
          total: projects.length,
        };
      }, logger),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List Super Productivity tags',
      description:
        'List tag IDs and titles, optionally filtered by a case-insensitive title substring. Use the IDs with search_tasks. TODAY is a virtual tag: search_tasks with tagId TODAY returns tasks due today, and plan_task_today adds a task to it; it is never stored on a task.',
      inputSchema: listByTitleInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: ListByTitleInput) =>
      withToolErrors(async () => {
        const tags = await client.listTags(input.query);
        return {
          tags: tags.map((tag) => ({ id: tag.id, title: tag.title })),
          total: tags.length,
        };
      }, logger),
  );

  server.registerTool(
    'list_today',
    {
      title: "List today's tasks",
      description: 'List tasks explicitly planned for Today in Super Productivity.',
      inputSchema: listTodayInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: ListTodayInput) =>
      withToolErrors(async () => {
        const tasks = await client.listTasks({
          tagId: 'TODAY',
          includeDone: input.includeDone,
          source: 'active',
        });
        const limited = tasks.slice(0, input.limit);
        return {
          tasks: limited.map((task) => summarizeTask(task)),
          totalToday: tasks.length,
          returned: limited.length,
          truncated: tasks.length > limited.length,
        };
      }, logger),
  );

  server.registerTool(
    'plan_task_today',
    {
      title: 'Plan one task for Today',
      description:
        'Place exactly the supplied task ID in Today, optionally at an explicit ISO timestamp.',
      inputSchema: planTaskTodayInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: PlanTaskTodayInput) =>
      withToolErrors(async () => {
        const startAtMs = input.startAt ? Date.parse(input.startAt) : undefined;
        if (startAtMs !== undefined && todayDateString(new Date(startAtMs)) !== todayDateString()) {
          throw new AppError(
            'INVALID_INPUT',
            'startAt must fall on the current local day for plan_task_today',
          );
        }
        const task = await client.updateTask(input.taskId, {
          ...(startAtMs === undefined
            ? { dueDay: todayDateString(), dueWithTime: null }
            : { dueDay: null, dueWithTime: startAtMs }),
        });
        return {
          task: summarizeTask(task),
          plannedForToday: true,
          mode: startAtMs === undefined ? 'all-day' : 'timed',
        };
      }, logger),
  );

  server.registerTool(
    'start_task',
    {
      title: 'Start one task',
      description: 'Start tracking exactly the supplied task ID as the current task.',
      inputSchema: taskActionInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: TaskActionInput) =>
      withToolErrors(async () => {
        const current = await client.startTask(input.taskId);
        const task = await client.getTask(input.taskId);
        return { currentTaskId: current.currentTaskId, task: summarizeTask(task) };
      }, logger),
  );

  server.registerTool(
    'stop_timer',
    {
      title: 'Stop the current timer',
      description: 'Stop the Super Productivity timer without selecting or changing another task.',
      inputSchema: emptyInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async () =>
      withToolErrors(async () => {
        const result = await client.stopTimer();
        return { currentTaskId: result.currentTaskId, stopped: true };
      }, logger),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete one task',
      description: 'Mark exactly the supplied task ID as completed.',
      inputSchema: taskActionInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: TaskActionInput) =>
      withToolErrors(async () => {
        const task = await client.updateTask(input.taskId, { isDone: true });
        return { completed: true, task: summarizeTask(task) };
      }, logger),
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create one task',
      description:
        'Create exactly one task. It goes to the Inbox unless projectId or projectName is given, and gets only the tags, due date, and estimate passed as fields (never the ones of the view open in the app). Pass parentId to create a subtask; subtasks inherit project and tags from the parent. Put project, tags, dates, and estimates in their fields, never in the title: titles containing short syntax (#tag, +project, @date, !deadline, 30m) are rejected with TITLE_HAS_SHORT_SYNTAX unless the server is configured for literal titles. Do not create a task the user did not ask for.',
      inputSchema: createTaskInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CreateTaskToolInput) =>
      withToolErrors(async () => {
        assertLiteralTitle(input.title, config.literalTitles);
        const due = resolveDue(input);
        const timeEstimate =
          input.timeEstimateMinutes === undefined
            ? undefined
            : minutesToMs(input.timeEstimateMinutes);

        if (input.parentId) {
          if (input.projectId || input.projectName || input.tagIds || input.tagNames) {
            throw new AppError(
              'INVALID_INPUT',
              'Subtasks inherit project and tags from their parent; omit them when parentId is set',
            );
          }
          const task = await client.createTask({
            title: input.title,
            parentId: input.parentId,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(due ?? {}),
            ...(timeEstimate !== undefined ? { timeEstimate } : {}),
          });
          return { created: true, task: summarizeTask(task) };
        }

        const [projectId, tagIds] = await Promise.all([
          resolveProjectId(client, input),
          resolveTagIds(client, input),
        ]);
        // Every placement field is sent explicitly: the API otherwise fills
        // project, tags, and Today from whatever view is open in the app.
        const task = await client.createTask({
          title: input.title,
          projectId: projectId ?? INBOX_PROJECT_ID,
          tagIds: tagIds ?? [],
          ...(due ?? { dueDay: null }),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(timeEstimate !== undefined ? { timeEstimate } : {}),
        });
        return { created: true, task: summarizeTask(task) };
      }, logger),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update one task',
      description:
        'Change fields of exactly one task by ID; omitted fields stay unchanged. tagIds/tagNames replace all tags of the task. dueDay or dueAt set the due date, null clears it. Project and tag names must match exactly. Read the task first with get_task when the change depends on its current values. Only change what the user asked for: notes and tags replace the current values, so keep the existing notes and tags unless the user asked to change them.',
      inputSchema: updateTaskInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: UpdateTaskToolInput) =>
      withToolErrors(async () => {
        const { taskId, title, notes, isDone, timeEstimateMinutes } = input;
        const due = resolveDue(input);
        const [projectId, tagIds] = await Promise.all([
          resolveProjectId(client, input),
          resolveTagIds(client, input),
        ]);
        const changes = {
          ...(title !== undefined ? { title } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(isDone !== undefined ? { isDone } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(tagIds !== undefined ? { tagIds } : {}),
          ...(due ?? {}),
          ...(timeEstimateMinutes !== undefined
            ? { timeEstimate: minutesToMs(timeEstimateMinutes) }
            : {}),
        };
        if (Object.keys(changes).length === 0) {
          throw new AppError('INVALID_INPUT', 'Pass at least one field to change');
        }
        // Super Productivity 19.0.x parses short syntax out of a title only when
        // the title is the sole change, so send the current notes along with it.
        if (Object.keys(changes).length === 1 && title !== undefined) {
          const current = await client.getTask(taskId);
          Object.assign(changes, { notes: current.notes ?? '' });
        }
        const task = await client.updateTask(taskId, changes);
        return { updated: true, task: summarizeTask(task) };
      }, logger),
  );

  server.registerTool(
    'get_current_task',
    {
      title: 'Get the current task',
      description: 'Return the task currently being tracked, or null when the timer is stopped.',
      inputSchema: emptyInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      withToolErrors(async () => {
        const task = await client.getCurrentTask();
        return { task: task ? summarizeTask(task) : null };
      }, logger),
  );

  server.registerTool(
    'ensure_github_issue_task',
    {
      title: 'Ensure one task for a GitHub issue',
      description:
        'Find an existing native or Super Productivity MCP-marked task for owner/repo#number or a GitHub issue URL. Create at most one marked task if missing; it is not planned for Today unless planToday=true.',
      inputSchema: ensureGithubIssueInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: EnsureGithubIssueInput) =>
      withToolErrors(async () => {
        const issue = parseGithubIssueRef(input.issue);
        const tasks = await client.listTasks({ source: 'all', includeDone: true });
        const match = findGithubIssueTask(tasks, issue);
        let task: SpTask;
        let created = false;
        let matchKind: string;

        if (match) {
          task = match.task;
          matchKind = match.kind;
        } else {
          const title =
            input.title ?? `GitHub issue ${issue.number} — ${issue.owner}/${issue.repo}`;
          assertLiteralTitle(title, config.literalTitles);
          // POST /tasks does not check the project, and a task whose project is
          // missing or archived shows up in no project list.
          if (input.projectId) {
            const projects = await client.listProjects();
            if (!projects.some((p) => p.id === input.projectId && !p.isArchived)) {
              throw new AppError('PROJECT_NOT_FOUND', 'Project not found or archived');
            }
          }
          // Placement is sent explicitly: POST /tasks otherwise takes project,
          // tags and a Today due date from whichever view is open in the app.
          task = await client.createTask({
            title,
            notes: addGithubMarker(input.notes, issue),
            projectId: input.projectId ?? 'INBOX_PROJECT',
            tagIds: [],
            dueDay: null,
          });
          created = true;
          matchKind = 'created-marker';
        }

        if (input.planToday) {
          task = await client.updateTask(task.id, {
            dueDay: todayDateString(),
            dueWithTime: null,
          });
        }

        return {
          created,
          matchKind,
          plannedForToday: input.planToday,
          issue: {
            owner: issue.owner,
            repo: issue.repo,
            number: issue.number,
            key: issue.key,
            url: issue.canonicalUrl,
          },
          task: summarizeTask(task),
        };
      }, logger),
  );

  return server;
};

export const startStdioServer = (dependencies: ServerDependencies): void => {
  // Importing here keeps the server factory usable in in-memory tests without
  // starting a process-level transport as a module side effect.
  void import('@modelcontextprotocol/server/stdio').then(({ serveStdio }) => {
    serveStdio(() => createMcpServer(dependencies), {
      onerror: (error) =>
        dependencies.logger.error('MCP stdio transport error', { message: error.message }),
    });
  });
};
