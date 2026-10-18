// Test-only recorded extraction. This worker is never imported by the app.
import { resolve } from 'node:path';
import { runCvExtraction } from '@career-workspace/core/cv';
import { LocalFolderStorage } from '@career-workspace/adapters/storage';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import {
  cvExtractionPrompt,
  cvExtractionSchema,
} from '@career-workspace/adapters/ai/cv-extract';
import { closeDatabase, getDatabase } from '@career-workspace/db';
if (
  !process.env.DATABASE_TEST_URL ||
  new URL(process.env.DATABASE_TEST_URL).pathname !== '/career_workspace_test'
)
  throw new Error('Use career_workspace_test only.');
process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { userId, taskId } = JSON.parse(input) as {
  userId: string;
  taskId: string;
};
try {
  const recording = createRecordedResponseGenerator({
    'cv-extract.v3': {
      facts: [
        {
          kind: 'experience',
          text: 'Volunteer scheduling',
          organisation: '',
          role: '',
          start: '',
          end: '',
          source_quote: 'Volunteer scheduling',
        },
        {
          kind: 'skill',
          text: 'Unverified example skill',
          organisation: '',
          role: '',
          start: '',
          end: '',
          source_quote: 'This quote is absent from the CV',
        },
      ],
    },
  });
  const completed = await runCvExtraction(userId, taskId, {
    database: getDatabase(),
    storage: new LocalFolderStorage(resolve('apps/web/.local-storage')),
    generate: (text) =>
      recording(cvExtractionPrompt, cvExtractionSchema, { cvText: text }),
  });
  process.stdout.write(JSON.stringify(completed));
} finally {
  await closeDatabase();
}
