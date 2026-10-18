/** Bounded live sample of public ATS directories. Never scans the full directory. */
import { fetchDiscoveryCompanyDataset } from '../src/discovery-dataset';
import { fetchDiscoveryBoard, type DiscoveryProvider, type DiscoverySource } from '../src/job-discovery';
import { canonicalJobUrl } from '../../core/src/roles';

const MAX_SAMPLE_PER_PROVIDER = 20;
const sampleArg = process.argv.find(value => value.startsWith('--sample='));
const sampleCount = sampleArg ? Number(sampleArg.slice('--sample='.length)) : 10;
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > MAX_SAMPLE_PER_PROVIDER) {
  throw new Error(`Use --sample=1 through --sample=${MAX_SAMPLE_PER_PROVIDER}; this verifier never performs a full directory scan.`);
}

const providers: DiscoveryProvider[] = ['greenhouse', 'lever', 'ashby'];
const canonicalUrls = new Set<string>();
const results: Record<string, unknown>[] = [];

function evenlySpacedSample(sources: DiscoverySource[], count: number) {
  if (sources.length <= count) return sources;
  return Array.from({ length: count }, (_, index) => sources[Math.floor(index * (sources.length - 1) / (count - 1 || 1))]!);
}

for (const provider of providers) {
  const dataset = await fetchDiscoveryCompanyDataset(provider);
  const sample = evenlySpacedSample(dataset.sources, sampleCount);
  const providerResults: Record<string, unknown>[] = new Array(sample.length);
  let cursor = 0;
  async function worker() {
    while (cursor < sample.length) {
      const index = cursor++;
      const source = sample[index]!;
      let httpStatus: number | null = null;
      let rowCounts: { received: number; normalized: number } | null = null;
      try {
        const jobs = await fetchDiscoveryBoard(source, {
          timeoutMs: 8_000,
          onHttpStatus: status => { httpStatus = status; },
          onRowCounts: (received, normalized) => { rowCounts = { received, normalized }; },
        });
        for (const job of jobs) canonicalUrls.add(canonicalJobUrl(job.url));
        providerResults[index] = {
          source: source.id,
          httpStatus,
          normalizedJobs: jobs.length,
          rejectedRows: rowCounts ? rowCounts.received - rowCounts.normalized : null,
          sampleJob: jobs[0] ? { title: jobs[0].title, url: canonicalJobUrl(jobs[0].url) } : null,
          error: jobs.length ? null : 'Board returned no usable open jobs.',
        };
      } catch (error) {
        providerResults[index] = {
          source: source.id,
          httpStatus,
          normalizedJobs: 0,
          rejectedRows: rowCounts ? rowCounts.received - rowCounts.normalized : null,
          sampleJob: null,
          error: error instanceof Error ? error.message : 'Unknown board failure.',
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, sample.length) }, worker));
  results.push({
    provider,
    validDirectoryBoards: dataset.sources.length,
    rejectedDirectoryEntries: dataset.rejected,
    sampleBoardsRequested: sample.length,
    sampleBoardsWithJobs: providerResults.filter(result => Number(result.normalizedJobs) > 0).length,
    boards: providerResults,
  });
}

const failedBoards = results.flatMap(result => result.boards as Record<string, unknown>[])
  .filter(result => !Number(result.normalizedJobs));
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  scope: 'bounded public sample only; no full-directory board sweep',
  samplePerProviderMaximum: MAX_SAMPLE_PER_PROVIDER,
  requestedSamplePerProvider: sampleCount,
  distinctCanonicalJobsInSample: canonicalUrls.size,
  failedSampleBoards: failedBoards.length,
  providers: results,
}, null, 2));
if (failedBoards.length) process.exitCode = 1;
