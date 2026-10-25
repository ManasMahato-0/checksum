import type { Response } from 'express';
import { z } from 'zod';

/**
 * Parse request input with a zod schema. On failure, answers 400 with the first problem as
 * `error` (what the UI shows) plus every issue with its field path, and returns undefined.
 */
export function parseOr400<S extends z.ZodType>(schema: S, input: unknown, res: Response): z.output<S> | undefined {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  res.status(400).json({
    error: r.error.issues[0]?.message ?? 'invalid request',
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
  return undefined;
}

// ---------------------------------------------------------------------------- schemas

export const Credentials = z.object({
  email: z
    .string({ error: 'a valid email is required' })
    .trim()
    .toLowerCase()
    .max(254, { error: 'a valid email is required' })
    .pipe(z.email({ error: 'a valid email is required' })),
  password: z
    .string({ error: 'password must be at least 8 characters' })
    .min(8, { error: 'password must be at least 8 characters' })
    .max(128, { error: 'password must be at most 128 characters' }),
});

export const NewAccount = z.object({
  name: z
    .string({ error: 'name is required (max 60 characters)' })
    .trim()
    .min(1, { error: 'name is required (max 60 characters)' })
    .max(60, { error: 'name is required (max 60 characters)' }),
});

export const CategoryBody = z.object({
  category: z
    .string({ error: 'body.category is required' })
    .trim()
    .min(1, { error: 'body.category is required' })
    .max(60, { error: 'category must be at most 60 characters' }),
});

export const ImportListQuery = z.object({
  limit: z.coerce.number({ error: 'limit must be a number' }).int().min(1).max(200).default(50),
});

export const TransactionsQuery = z.object({
  category: z.string().max(60).optional(),
});

export const NarrationBody = z.object({ narration: z.string().max(1000).default('') });
