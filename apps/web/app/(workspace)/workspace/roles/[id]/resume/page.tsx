import ResumeWorkspace from './resume-workspace';

export default async function ResumePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ prepare?: string }>;
}) {
  const { id } = await params;
  const { prepare } = await searchParams;
  return <ResumeWorkspace opportunityId={id} prepare={prepare === '1'} />;
}
