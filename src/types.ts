import { z } from 'zod/v4';

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().finite().nullable().optional();

/**
 * The local REST API deliberately returns the complete Super Productivity task
 * object. We validate the stable fields we consume and preserve unknown fields
 * so a newer Super Productivity release does not break this server.
 */
export const SpTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    isDone: z.boolean().optional(),
    projectId: nullableString,
    tagIds: z.array(z.string()).optional(),
    notes: nullableString,
    dueDay: nullableString,
    dueWithTime: nullableNumber,
    timeEstimate: z.number().finite().optional(),
    timeSpent: z.number().finite().optional(),
    parentId: nullableString,
    subTaskIds: z.array(z.string()).optional(),
    issueId: z.union([z.string(), z.number()]).nullable().optional(),
    issueType: nullableString,
    issueProviderId: nullableString,
  })
  .passthrough();

export type SpTask = z.infer<typeof SpTaskSchema>;

export const SpProjectSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    isArchived: z.boolean().optional(),
  })
  .passthrough();

export type SpProject = z.infer<typeof SpProjectSchema>;

export const SpHealthSchema = z
  .object({
    server: z.string(),
    rendererReady: z.boolean(),
  })
  .passthrough();

export type SpHealth = z.infer<typeof SpHealthSchema>;

export const SpCurrentTaskIdSchema = z.object({
  currentTaskId: z.string().nullable(),
});

export type SpCurrentTaskId = z.infer<typeof SpCurrentTaskIdSchema>;

export const SpErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export type SpError = z.infer<typeof SpErrorSchema>;

export const SpSuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
});

export const SpErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: SpErrorSchema,
});

export const SpEnvelopeSchema = z.union([SpSuccessEnvelopeSchema, SpErrorEnvelopeSchema]);

export type SpEnvelope = z.infer<typeof SpEnvelopeSchema>;
