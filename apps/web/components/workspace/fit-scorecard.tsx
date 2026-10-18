import {
  fitScoreBandLabels,
  type FitScoreBand,
  type FitScoreEvidenceStatus,
  type FitScorecard,
} from '@career-workspace/contracts';
import s from './workspace.module.css';

export function FitBandBadge({ band }: { band?: FitScoreBand | null }) {
  if (!band) return null;
  const colorClass =
    band === 'strong_fit'
      ? s.green
      : band === 'worth_a_try'
        ? s.yellow
        : band === 'stretch'
          ? s.amber
          : s.neutral;
  return (
    <span className={`${s.badge} ${colorClass}`}>
      {fitScoreBandLabels[band]}
    </span>
  );
}

export function FitScorecardView({
  scorecard,
  factTexts = {},
}: {
  scorecard: FitScorecard | null | undefined;
  factTexts?: Record<string, string>;
}) {
  if (!scorecard) return null;
  const evidenceLabel = (status: FitScoreEvidenceStatus) =>
    status === 'supported'
      ? 'supported by evidence'
      : status === 'partial'
        ? 'partly supported'
        : 'not enough information';
  const gapCount =
    scorecard.factors.cvMatch.total -
    scorecard.factors.cvMatch.met -
    scorecard.factors.cvMatch.unknown;
  const factorRows = [
    {
      label: 'Professional requirements',
      value: `${scorecard.factors.cvMatch.met} met · ${gapCount} ${gapCount === 1 ? 'gap' : 'gaps'} · ${scorecard.factors.cvMatch.unknown} unknown of ${scorecard.factors.cvMatch.total} requirements · ${scorecard.factors.cvMatch.weightedMet} of ${scorecard.factors.cvMatch.weightedTotal} matched weight`,
      evidence: scorecard.evidence.cvMatch,
    },
    {
      label: 'Target role',
      value:
        scorecard.factors.targetRoleAlignment.status === 'aligned'
          ? `Aligned${scorecard.factors.targetRoleAlignment.matchedRole ? ` · ${scorecard.factors.targetRoleAlignment.matchedRole}` : ''}`
          : scorecard.factors.targetRoleAlignment.status === 'not_aligned'
            ? 'Not aligned'
            : 'Unknown',
      evidence: scorecard.evidence.targetRoleAlignment,
    },
    {
      label: 'Compensation',
      value:
        scorecard.factors.compensation.status === 'stated'
          ? scorecard.factors.compensation.evidence ||
            'Stated in the job description'
          : 'Not stated',
      evidence: scorecard.evidence.compensation,
    },
    {
      label: 'Culture signals',
      value:
        scorecard.factors.culture.status === 'stated'
          ? scorecard.factors.culture.evidence ||
            'Stated in the job description'
          : 'Not stated',
      evidence: scorecard.evidence.culture,
    },
    {
      label: 'Eligibility flags · not a full red-flag assessment',
      value: scorecard.factors.constraints.length
        ? `${scorecard.factors.constraints.length} stated condition${scorecard.factors.constraints.length === 1 ? '' : 's'}`
        : 'No eligibility flags extracted; check the job text',
      evidence: scorecard.evidence.redFlags,
    },
  ];
  const bandClass =
    scorecard.band === 'strong_fit'
      ? s.green
      : scorecard.band === 'worth_a_try'
        ? s.yellow
        : scorecard.band === 'stretch'
          ? s.amber
          : s.neutral;
  return (
    <section
      className={s.verdict}
      aria-labelledby="fit-score-title"
      style={{
        background: 'var(--surface-paper)',
        color: 'var(--color-carbon)',
        border: '1px solid var(--color-concrete)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          alignItems: 'start',
        }}
      >
        <div>
          <h3 id="fit-score-title">Fit score</h3>
          <p>
            How well your confirmed experience matches what this job asks for.
            It is not a chance of being hired.
          </p>
          <p>
            <strong>Best next action:</strong> {scorecard.nextAction}
          </p>
        </div>
        <div style={{ display: 'grid', justifyItems: 'end', gap: 6 }}>
          {scorecard.score === null ? null : (
            <strong aria-label={`${scorecard.score} out of 5`}>
              {Number(scorecard.score.toFixed(1))}
              <small> / 5</small>
            </strong>
          )}
          <span className={`${s.badge} ${bandClass}`}>
            {fitScoreBandLabels[scorecard.band]}
          </span>
          <span>{scorecard.confidence} confidence</span>
        </div>
      </div>
      {scorecard.score !== null && (
        <p>
          Calculation: fixed starting point 1 + 4 × matched weight ÷ assessed
          weight = {scorecard.rawScore?.toFixed(1) ?? '—'} raw (
          {scorecard.factors.cvMatch.weightedMet} ÷{' '}
          {scorecard.factors.cvMatch.weightedTotal}).{' '}
          {scorecard.capReason
            ? `Capped at ${scorecard.score.toFixed(1)} because ${scorecard.capReason === 'essential_gap' ? 'a verified essential gap is present' : scorecard.capReason === 'thin_evidence' ? 'no essential requirement has been assessed' : 'more than half of the essential requirements are unknown'}.`
            : `Final score ${scorecard.score.toFixed(1)}.`}
        </p>
      )}
      {scorecard.score === null && (
        <p>
          No number is shown because there is not enough confirmed evidence to
          assess the requirements.
        </p>
      )}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
          margin: '16px 0',
        }}
      >
        {factorRows.map((factor) => (
          <div
            key={factor.label}
            style={{
              borderTop: '1px solid var(--color-concrete)',
              paddingTop: 8,
            }}
          >
            <dt>{factor.label}</dt>
            <dd>{factor.value}</dd>
            <small style={{ color: 'var(--color-iron)' }}>
              Evidence: {evidenceLabel(factor.evidence)}
            </small>
          </div>
        ))}
      </dl>
      {scorecard.factors.constraints.length > 0 && (
        <div>
          <h4>Constraints to check</h4>
          <ul>
            {scorecard.factors.constraints.map((constraint, index) => (
              <li key={`${constraint.kind}-${index}`}>
                <strong>{constraint.text}</strong> · {constraint.status}{' '}
                <q>{constraint.quote}</q>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>Requirement evidence and score points</summary>
        <ol>
          {scorecard.requirements.map((requirement, index) => (
            <li
              key={`${requirement.text}-${index}`}
              style={{ marginBlock: 12 }}
            >
              <strong>{requirement.text}</strong>
              <p>
                <q>{requirement.quote}</q>
              </p>
              <p>
                {requirement.importance} · {requirement.status} · weight{' '}
                {requirement.nominalWeight} · counted weight{' '}
                {requirement.weight} · earned{' '}
                {requirement.contribution.toFixed(2)} points
              </p>
              {requirement.gapVerification === 'unverified' && (
                <p>
                  Unverified gap · treated as unknown and not counted against
                  the score.
                </p>
              )}
              {requirement.fact_ids.length ? (
                <ul>
                  {requirement.fact_ids.map((factId) => (
                    <li key={factId}>
                      <a href="/workspace/profile#facts-heading">
                        {factTexts[factId] ||
                          `Approved profile fact ${factId.slice(0, 8)}…`}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No approved profile facts were cited.</p>
              )}
            </li>
          ))}
        </ol>
      </details>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
        }}
      >
        <div>
          <h4>Top matches</h4>
          {scorecard.matched.length ? (
            <ul>
              {scorecard.matched.slice(0, 3).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No confirmed matches listed.</p>
          )}
        </div>
        <div>
          <h4>Top gaps</h4>
          {scorecard.gaps.length ? (
            <ul>
              {scorecard.gaps.slice(0, 3).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No gaps listed.</p>
          )}
        </div>
      </div>
      {scorecard.checks.length > 0 && (
        <div>
          <h4>What could change this</h4>
          <ul>
            {scorecard.checks.slice(0, 3).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
