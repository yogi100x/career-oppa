import { describe, expect, it } from 'vitest';
import type { ResumeContent } from '@career-workspace/contracts';
import {
  classifyJobSkills,
  compareJobDescriptionSimilarity,
  rankResumeContentForRole,
} from './resume-preparation';

const skillId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';

describe('classifyJobSkills', () => {
  it('uses current approved facts, distinguishes listed skills from supported experience, and ranks essentials first', () => {
    const result = classifyJobSkills({
      jobText: 'Excel and customer service are essential. Python would be useful.',
      approvedFacts: [
        { id: skillId, kind: 'skill', text: 'Excel spreadsheets' },
        { id: projectId, kind: 'experience', text: 'Worked in customer service handling billing problems' },
      ],
      fitRequirements: [
        { text: 'Excel skills', quote: 'Excel and customer service are essential', importance: 'essential', status: 'gap', fact_ids: [] },
        { text: 'Customer service', quote: 'Excel and customer service are essential', importance: 'essential', status: 'met', fact_ids: [projectId] },
        { text: 'Python', quote: 'Python would be useful', importance: 'desirable', status: 'met', fact_ids: [skillId] },
      ],
    });
    expect(result.buckets.existing.map((row) => row.skill)).toContain('excel');
    expect(result.buckets.supportedByResume.map((row) => row.skill)).toContain('customer service');
    expect(result.buckets.gaps.map((row) => row.skill)).toContain('python');
    expect(result.buckets.gaps.find((row) => row.skill === 'python')?.factIds).toEqual([]);
    expect(result.buckets.existing[0].priority).toBe('essential');
  });

  it('does not let an old fit review status or fact IDs claim a skill that current facts do not show', () => {
    const result = classifyJobSkills({
      jobText: 'Experience with TypeScript is essential.',
      approvedFacts: [],
      fitRequirements: [{
        text: 'TypeScript', quote: 'Experience with TypeScript is essential.',
        importance: 'essential', status: 'met', fact_ids: [skillId],
      }],
    });
    expect(result.buckets.gaps).toMatchObject([{ skill: 'typescript', factIds: [] }]);
  });

  it('uses UK and India synonyms already supported by keyword coverage', () => {
    const result = classifyJobSkills({
      jobText: 'A degree in B.Tech and strong spreadsheet skills are useful.',
      approvedFacts: [
        { id: skillId, kind: 'education', text: 'Bachelor of Technology' },
        { id: projectId, kind: 'experience', text: 'Prepared weekly Excel reports' },
      ],
    });
    expect(result.buckets.supportedByResume.map((row) => row.skill)).toContain('b.tech');
    expect(result.buckets.supportedByResume.map((row) => row.skill)).toContain('spreadsheet');
  });

  it('does not mislabel the job title itself as a missing skill', () => {
    const result = classifyJobSkills({
      jobTitle: 'Software Engineer',
      jobText: 'Software Engineer wanted, with TypeScript experience preferred.',
      approvedFacts: [],
    });
    expect(result.buckets.gaps.map((row) => row.skill)).not.toContain('software engineer');
    expect(result.buckets.gaps.map((row) => row.skill)).toContain('typescript');
  });

  it('does not turn a denial or future learning wish into supported skill', () => {
    const result = classifyJobSkills({
      jobText: 'Experience with Python and SQL is essential.',
      approvedFacts: [
        { id: skillId, kind: 'skill', text: 'No experience with Python.' },
        { id: projectId, kind: 'experience', text: 'I want to learn SQL.' },
      ],
    });
    expect(result.buckets.existing).toEqual([]);
    expect(result.buckets.supportedByResume).toEqual([]);
    expect(result.buckets.gaps.map(row => row.skill)).toEqual(expect.arrayContaining(['python', 'sql']));
  });

  it('keeps named skills separate from ordinary uses of Excel and go', () => {
    const result = classifyJobSkills({
      jobText: 'Experience with Excel and Go is essential.',
      approvedFacts: [
        { id: skillId, kind: 'experience', text: 'I excel at teamwork.' },
        { id: projectId, kind: 'experience', text: 'Willing to go the extra mile.' },
      ],
      fitRequirements: [
        { text: 'Excel', quote: 'Experience with Excel and Go is essential.', importance: 'essential', status: 'unknown', fact_ids: [] },
        { text: 'Go', quote: 'Experience with Excel and Go is essential.', importance: 'essential', status: 'unknown', fact_ids: [] },
      ],
    });
    expect(result.buckets.gaps.map((row) => row.skill)).toEqual(expect.arrayContaining(['excel', 'go']));
    expect(result.buckets.supportedByResume).toEqual([]);
  });

  it('accepts correctly named Excel and Go skills in current approved facts', () => {
    const result = classifyJobSkills({
      jobText: 'Experience with Excel and Go is essential.',
      approvedFacts: [
        { id: skillId, kind: 'skill', text: 'Excel spreadsheets' },
        { id: projectId, kind: 'experience', text: 'Built a service in Go' },
      ],
      fitRequirements: [
        { text: 'Excel', quote: 'Experience with Excel and Go is essential.', importance: 'essential', status: 'unknown', fact_ids: [] },
        { text: 'Go', quote: 'Experience with Excel and Go is essential.', importance: 'essential', status: 'unknown', fact_ids: [] },
      ],
    });
    expect(result.buckets.existing.map((row) => row.skill)).toContain('excel');
    expect(result.buckets.supportedByResume.map((row) => row.skill)).toContain('go');
    const ambiguousSynonym = classifyJobSkills({
      jobText: 'Experience with Excel is essential.',
      approvedFacts: [{ id: projectId, kind: 'experience', text: 'Prepared weekly spreadsheets' }],
    });
    expect(ambiguousSynonym.buckets.gaps.map((row) => row.skill)).toContain('excel');
  });

  it('does not remove meaningful punctuation to manufacture a skill match', () => {
    const result = classifyJobSkills({
      jobText: 'Experience with C++ and C# is essential.',
      approvedFacts: [{ id: skillId, kind: 'skill', text: 'C#' }],
    });
    expect(result.buckets.existing.map(row => row.skill)).toContain('c#');
    expect(result.buckets.gaps.map(row => row.skill)).toContain('c++');
    expect(new Set([...result.buckets.existing, ...result.buckets.gaps].map(row => row.id)).size).toBe(2);
  });

  it('marks detection incomplete when quoted requirements cannot be parsed', () => {
    const result = classifyJobSkills({
      jobText: 'Must be comfortable working in a fast-paced environment.',
      approvedFacts: [],
      fitRequirements: [{
        text: 'Comfortable in a fast-paced environment',
        quote: 'comfortable working in a fast-paced environment',
        importance: 'essential', status: 'unknown', fact_ids: [],
      }],
    });
    expect(result.incompleteDetection).toBe(true);
    expect(result.incompleteRequirements).toContain('Comfortable in a fast-paced environment');
  });
});

describe('compareJobDescriptionSimilarity', () => {
  it('uses the stated reuse, edit, and generate thresholds', () => {
    const same = 'Senior UX designer research usability prototypes accessibility portfolio figma wireframes interviews testing analytics journeys surveys stakeholders collaboration strategy product discovery workshops metrics experimentation validation user centered design systems';
    expect(compareJobDescriptionSimilarity({ jobText: same, priorJobText: same }).action).toBe('reuse');
    expect(compareJobDescriptionSimilarity({
      jobText: 'Senior UX designer research usability analytics portfolio interviews testing journeys stakeholders collaboration product discovery metrics experimentation personas service blueprints accessibility prototypes governance roadmaps',
      priorJobText: same,
    }).action).toBe('edit');
    expect(compareJobDescriptionSimilarity({ jobText: 'Chef kitchen menu', priorJobText: 'Cloud security Terraform' }).action).toBe('generate');
  });

  it('never recommends reuse for empty, stop-word-only, or short descriptions', () => {
    for (const text of ['', 'the and to with', 'engineer teamwork research']) {
      expect(compareJobDescriptionSimilarity({ jobText: text, priorJobText: text }))
        .toMatchObject({ action: 'generate', reason: 'similarity_low', similarity: 0 });
    }
    const nineteenTerms = Array.from({ length: 19 }, (_, index) => `token${index}`).join(' ');
    expect(compareJobDescriptionSimilarity({ jobText: nineteenTerms, priorJobText: nineteenTerms }))
      .toMatchObject({ action: 'generate', reason: 'similarity_low', similarity: 0 });
  });

  it('forces generation for clear seniority changes, and ignores ordinary uses of junior-like words outside titles', () => {
    const jobText = 'Engineer delivering software to junior customers';
    expect(compareJobDescriptionSimilarity({
      jobText, priorJobText: jobText, jobTitle: 'Senior Software Engineer', priorJobTitle: 'Junior Software Engineer',
    })).toMatchObject({ action: 'generate', reason: 'seniority_mismatch', similarity: 1 });
    expect(compareJobDescriptionSimilarity({
      jobText, priorJobText: jobText, jobTitle: 'Software Engineer', priorJobTitle: 'Software Engineer',
    }).action).toBe('generate');
  });
});

describe('rankResumeContentForRole', () => {
  it('moves relevant sections and project bullets up without changing facts or dated-entry order', () => {
    const oldEntry = { title: 'Analyst', organisation: 'A', start: '2020', end: '2021', fact_ids: [skillId], bullets: [] };
    const newEntry = { title: 'Analyst', organisation: 'B', start: '2022', end: '2023', fact_ids: [projectId], bullets: [{ text: 'Handled customer service and created Excel reports', fact_ids: [projectId] }] };
    const content: ResumeContent = {
      name: 'A Person', contact: '',
      sections: [
        { title: 'Projects', bullets: [
          { text: 'Designed a poster for the event', fact_ids: [projectId] },
          { text: 'Built Excel reports', fact_ids: [skillId] },
        ] },
        { title: 'Skills', bullets: [{ text: 'Excel spreadsheets', fact_ids: [skillId] }] },
        { title: 'Summary', bullets: [{ text: 'Summarised relevant experience with Excel', fact_ids: [skillId] }] },
        { title: 'Experience', bullets: [], entries: [newEntry, oldEntry] },
      ],
    };
    const result = rankResumeContentForRole({
      content,
      requirements: [{ text: 'Excel customer service', importance: 'essential' }],
      matchedSkills: ['Excel'],
    });
    expect(result.sections.map((section) => section.title)).toEqual(['Summary', 'Skills', 'Experience', 'Projects']);
    const projects = result.sections.find((section) => section.title === 'Projects')!;
    expect(projects.bullets[0].text).toContain('Excel reports');
    expect(projects.bullets[0].fact_ids).toEqual([skillId]);
    expect(result.sections.find((section) => section.title === 'Experience')?.entries?.map((entry) => entry.start)).toEqual(['2022', '2020']);
    expect(result.name).toBe(content.name);
  });
});
