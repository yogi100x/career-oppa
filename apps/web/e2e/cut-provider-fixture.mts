import { getResumePreparation } from '@career-workspace/core/resume-preparation-service';
// Test-only ESM worker: Playwright's CommonJS loader cannot load the AI SDK's
// import.meta prompts. It is never imported by the application.
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import { closeDatabase, getDatabase } from '@career-workspace/db';
import { createFitReview } from '@career-workspace/core/fit-review';
import { createTailoredResume } from '@career-workspace/core/resumes';
import { createTask } from '@career-workspace/core/tasks';
import { runCvExtraction } from '@career-workspace/core/cv';

if (
  !process.env.DATABASE_TEST_URL ||
  new URL(process.env.DATABASE_TEST_URL).pathname !== '/career_workspace_test'
)
  throw new Error('Recorded test providers require career_workspace_test.');
process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
let input = '';
for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input) as {
  action: 'fit' | 'cv' | 'resume';
  userId: string;
  id: string;
  key?: string;
  factText?: string;
  factId?: string;
};
const database = getDatabase();
let result: unknown;
try {
  if (data.action === 'fit') {
    const fitReply = {
      verdict:
        'Your personal fit is not known yet. Review these requirements first.',
      requirements: [
        {
          text: 'The role requires working on site.',
          importance: 'essential',
          status: 'constraint',
          fact_ids: [],
          job_quote: 'Work on site',
        },
      ],
    };
    result = await createFitReview(data.userId, data.id, data.key!, {
      database,
      generate: createRecordedResponseGenerator({
        'fit-review.v5': fitReply,
        'fit-review.v6': fitReply,
      }),
    });
  } else if (data.action === 'cv') {
    const task = await createTask(
      data.userId,
      'cv_extract',
      `cut-cv:${data.id}`,
      { fileId: data.id },
      database,
    );
    result = await runCvExtraction(data.userId, task.id, {
      database,
      generate: async () => ({
        object: {
          facts: [
            {
              kind: 'skill',
              text: data.factText!,
              organisation: '',
              role: '',
              start: '',
              end: '',
              source_quote: '',
            },
          ],
        },
        promptVersion: 'cv-extract.v3',
        model: 'recorded-test-response',
      }),
    });
  } else if (data.action === 'resume') {
    result = await createTailoredResume(data.userId, data.id, data.key!, {
      database,
      confirmedSkills: true,
      preparationToken: (await getResumePreparation(data.userId, data.id, database)).token,
      generate: createRecordedResponseGenerator({
        'tailor-cv.v6': {
          name: '',
          contact: '',
          sections: [
            {
              title: 'Projects',
              bullets: [{ text: data.factText!, fact_ids: [data.factId!] }],
              entries: [],
            },
          ],
          notes_for_candidate: [],
          left_out: [],
        },
      }),
    });
  } else throw new Error('Unknown recorded fixture action.');
  console.log(JSON.stringify(result));
} finally {
  await closeDatabase();
}
