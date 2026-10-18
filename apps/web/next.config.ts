import type { NextConfig } from 'next';
import { join } from 'node:path';
import { withWorkflow } from 'workflow/next';

const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  turbopack: { root: join(__dirname, '../..') },
  serverExternalPackages: ['pdfjs-dist', 'mammoth'],
  outputFileTracingRoot: join(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/api/v1/profile/cv': [
      '../../packages/adapters/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
    // Workflow executes the CV task from its generated flow route, so trace
    // the PDF worker there as well as in the upload request that starts it.
    '/.well-known/workflow/v1/flow': [
      '../../packages/adapters/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
    '/.well-known/workflow/v1/webhook/*': [
      '../../packages/adapters/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
    // Bundled CV fonts read from disk by the PDF renderer.
    '/api/v1/resumes/**': ['../../packages/pdf/fonts/*.ttf'],
  },
};

export default withWorkflow(config);
