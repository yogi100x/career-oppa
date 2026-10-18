export function shouldReviewSavedCv(
  cv: { file: { id: string } | null; state: string },
  hasApprovedFacts: boolean,
  hasTargetRole: boolean,
) {
  return Boolean(
    cv.file &&
      !hasApprovedFacts &&
      !hasTargetRole &&
      cv.state !== 'confirmed',
  );
}
