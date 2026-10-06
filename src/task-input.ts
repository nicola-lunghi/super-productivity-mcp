import { z } from 'zod/v4';

import { AppError } from './errors.js';
import type { SuperProductivityClient } from './sp-client.js';

export const INBOX_PROJECT_ID = 'INBOX_PROJECT';
export const TODAY_TAG_ID = 'TODAY';

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 200;
const MAX_TAGS = 20;

const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
const nameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);

export const taskTitleSchema = z.string().trim().min(1).max(500);
export const taskNotesSchema = z.string().max(10_000);
export const projectIdSchema = idSchema;
export const projectNameSchema = nameSchema;
export const tagIdsSchema = z.array(idSchema).max(MAX_TAGS);
export const tagNamesSchema = z.array(nameSchema).max(MAX_TAGS);
export const timeEstimateMinutesSchema = z.number().int().min(0).max(100_000);

export const dueDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'dueDay must be a YYYY-MM-DD date')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, 'dueDay must be a real calendar date');

export const dueAtSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      /T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)),
    'dueAt must be an ISO-8601 timestamp with an explicit timezone offset',
  );

interface Named {
  readonly id: string;
  readonly title: string;
}

/**
 * Matches a user-facing name to exactly one item, ignoring case and surrounding
 * whitespace. Never guesses: no match and several matches are both errors.
 */
export const resolveExactName = <T extends Named>(
  name: string,
  candidates: readonly T[],
  kind: 'project' | 'tag',
): T => {
  const normalized = name.trim().toLocaleLowerCase();
  const matches = candidates.filter((item) => item.title.trim().toLocaleLowerCase() === normalized);
  const [first] = matches;
  if (!first) {
    throw new AppError(`${kind.toUpperCase()}_NOT_FOUND`, `No ${kind} is named "${name}"`);
  }
  if (matches.length > 1) {
    throw new AppError('AMBIGUOUS_NAME', `More than one ${kind} is named "${name}"; use its ID`, {
      details: matches.map(({ id, title }) => ({ id, title })),
    });
  }
  return first;
};

/** Resolves an explicit project ID or exact project name to an active project ID. */
export const resolveProjectId = async (
  client: SuperProductivityClient,
  input: { readonly projectId?: string | undefined; readonly projectName?: string | undefined },
): Promise<string | undefined> => {
  if (input.projectId && input.projectName) {
    throw new AppError('INVALID_INPUT', 'Provide projectId or projectName, not both');
  }
  if (!input.projectId && !input.projectName) return undefined;

  const projects = (await client.listProjects()).filter((project) => !project.isArchived);
  if (input.projectName) {
    return resolveExactName(input.projectName, projects, 'project').id;
  }
  if (!projects.some((project) => project.id === input.projectId)) {
    throw new AppError('PROJECT_NOT_FOUND', 'Project not found or archived');
  }
  return input.projectId;
};

/**
 * Resolves explicit tag IDs or exact tag names to existing tag IDs. TODAY is
 * virtual (membership comes from the due date), so it is rejected here.
 */
export const resolveTagIds = async (
  client: SuperProductivityClient,
  input: {
    readonly tagIds?: readonly string[] | undefined;
    readonly tagNames?: readonly string[] | undefined;
  },
): Promise<string[] | undefined> => {
  if (input.tagIds && input.tagNames) {
    throw new AppError('INVALID_INPUT', 'Provide tagIds or tagNames, not both');
  }
  if (!input.tagIds && !input.tagNames) return undefined;

  const tags = await client.listTags();
  const ids = input.tagNames
    ? input.tagNames.map((name) => resolveExactName(name, tags, 'tag').id)
    : [...(input.tagIds ?? [])];
  if (ids.includes(TODAY_TAG_ID)) {
    throw new AppError(
      'INVALID_INPUT',
      'TODAY is a virtual tag and cannot be assigned; set dueDay to today or use plan_task_today',
    );
  }
  const unknown = ids.filter((id) => !tags.some((tag) => tag.id === id));
  if (unknown.length > 0) {
    throw new AppError('TAG_NOT_FOUND', `Unknown tag ID(s): ${unknown.join(', ')}`);
  }
  return [...new Set(ids)];
};

/**
 * Turns the dueDay/dueAt inputs into the API's mutually exclusive due fields.
 * `null` clears the due date; `undefined` leaves it unchanged.
 */
export const resolveDue = (input: {
  readonly dueDay?: string | null | undefined;
  readonly dueAt?: string | null | undefined;
}): { dueDay: string | null; dueWithTime: number | null } | undefined => {
  if (input.dueDay && input.dueAt) {
    throw new AppError('INVALID_INPUT', 'Provide dueDay or dueAt, not both');
  }
  if (input.dueDay) return { dueDay: input.dueDay, dueWithTime: null };
  if (input.dueAt) return { dueDay: null, dueWithTime: Date.parse(input.dueAt) };
  if (input.dueDay === null || input.dueAt === null) return { dueDay: null, dueWithTime: null };
  return undefined;
};

export const minutesToMs = (minutes: number): number => minutes * 60_000;
