import { z } from 'zod';
export const postContentSchema = z
  .object({
    content: z.string().trim().min(1).max(5000),
    fact_ids: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();
export const createPostSchema = z
  .object({ projectId: z.string().uuid() })
  .strict();
export const editPostSchema = postContentSchema
  .extend({
    destination: z.enum(['copy', 'social']),
    connectionId: z.string().uuid().nullable(),
  })
  .strict();
export const approvePostSchema = z
  .object({
    content: z.string().min(1).max(5000),
    destination: z.enum(['copy', 'social']),
    connectionId: z.string().uuid().nullable(),
    confirmed: z.literal(true),
  })
  .strict();

export const publishingCallbackSchema = z.object({
  id: z.string().min(1).max(200),
  event: z.string(),
  post: z
    .object({
      id: z.string().min(1).max(200),
      platforms: z
        .array(
          z.object({
            platform: z.string(),
            accountId: z.string().optional(),
            status: z.string(),
            publishedUrl: z.string().optional(),
          }),
        )
        .max(100),
    })
    .optional(),
});
export type PublishingCallback = z.infer<typeof publishingCallbackSchema>;
