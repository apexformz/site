import type { SessionTechniqueReview as Review } from '@apexformz/contracts';
import { reviewMissingExplanation, sessionReviewPresentation } from '@/lib/brain/sessionTechniqueReview';

const readable = (value: string) => value.replace(/_/g, ' ');

export function SessionTechniqueReview({ review, historicalSnapshot = false }: { review: Review | null; historicalSnapshot?: boolean }) {
  const { corrections, passed, missing, unobserved, receivedCount, measuredCount, withheldMeasuredChecks, withheldMeasuredObservations } = sessionReviewPresentation(review);
  return <section className="glass-card p-6 sm:p-8" data-testid="session-technique-review">
    <h2 className="text-xl font-semibold">Your technique review</h2>
    <p className="mt-3 text-sm leading-relaxed text-muted">{receivedCount ? `Reviewed ${receivedCount} checks. ${measuredCount} received a measured verdict; ${receivedCount - measuredCount} still need evidence.` : 'No measurable technique checks were received in this session.'}</p>
    {!!review?.phases.length && <p className="mt-2 text-sm text-muted">Parts observed: {review.phases.map(readable).join(', ')}.</p>}
    <p className="mt-2 text-xs leading-relaxed text-subtle">{historicalSnapshot ? 'This older session contains only its final saved assessment.' : `${review?.nonempty_assessments ?? 0} assessment updates retained. Observation counts are measurements, not repetitions.`}</p>
    <div className="mt-7 space-y-7">
      <div>
        <h3 className="text-base font-semibold">Adjustments observed</h3>
        {corrections.length ? <ul className="mt-3 space-y-3">{corrections.map(entry => {
          const correction = entry.latest_correction!;
          const laterPass = entry.latest_measured?.state === 'PASS' && entry.latest_measured.timestamp_ms > correction.timestamp_ms;
          return <li key={`${entry.criterion_id}/${entry.phase_id}`} className="rounded-xl border border-accent-warning/30 bg-accent-warning/5 p-4" data-testid="session-review-correction">
            <p className="font-medium capitalize">{entry.name}{entry.phase_id ? ` · ${readable(entry.phase_id)}` : ''}</p>
            {!!correction.body_areas.length && <p className="mt-1 text-xs capitalize text-muted">Body area: {correction.body_areas.join(', ')}</p>}
            <p className="mt-2 text-sm leading-relaxed" data-testid="session-review-correction-instruction">{correction.correction ?? `Review ${entry.name.toLowerCase()} before your next attempt.`}</p>
            {correction.rationale && <p className="mt-1 text-xs leading-relaxed text-muted">{correction.rationale}</p>}
            <p className="mt-2 text-xs text-muted">Adjustment indicated on {entry.state_counts.IMPROVE ?? 0} of {entry.observations} observations.{correction.provisional ? ' Preview criterion.' : ''}{correction.source === 'live' ? ' Observed during movement.' : correction.source === 'attempt_review' ? ' Reviewed after the attempt.' : ' Reviewed retrospectively.'}</p>
            {laterPass && <p className="mt-2 text-xs text-secondary">A later observation was in range. This does not establish that every repetition was correct.</p>}
          </li>;
        })}</ul> : <p className="mt-3 text-sm leading-relaxed text-muted">No supported correction was recorded. The checks below show what was measured and what still needs evidence.</p>}
      </div>
      <div>
        <h3 className="text-base font-semibold">Checks in range</h3>
        {passed.length ? <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">{passed.map(entry => <li key={`${entry.criterion_id}/${entry.phase_id}`} className="rounded-xl border border-border p-3 text-sm" data-testid="session-review-passed"><span className="font-medium capitalize">{entry.name}</span>{entry.phase_id ? ` · ${readable(entry.phase_id)}` : ''}<span className="block mt-1 text-xs text-muted">In range on {entry.state_counts.PASS} of {entry.observations} observations.{entry.latest_measured?.provisional ? ' Preview criterion.' : ''}</span></li>)}</ul> : <p className="mt-3 text-sm text-muted">No check had enough evidence for an in-range verdict.</p>}
      </div>
      <div>
        <h3 className="text-base font-semibold">Missing or limited evidence</h3>
        {withheldMeasuredChecks > 0 && <p className="mt-3 text-xs leading-relaxed text-subtle" data-testid="session-review-withheld-summary">{withheldMeasuredObservations} observations were withheld across {withheldMeasuredChecks} otherwise measured checks. Their usable results are retained above; withheld observations are not counted as correct.</p>}
        {missing.length ? <ul className="mt-3 space-y-3">{missing.map(entry => <li key={`${entry.criterion_id}/${entry.phase_id}`} className="rounded-xl border border-border p-3" data-testid="session-review-missing"><p className="text-sm font-medium capitalize">{entry.name}{entry.phase_id ? ` · ${readable(entry.phase_id)}` : ''}</p><p className="mt-1 text-sm leading-relaxed text-muted">{reviewMissingExplanation(entry.latest_unassessed!)}</p><p className="mt-1 text-xs text-subtle">Withheld on {(entry.state_counts.UNCERTAIN ?? 0) + (entry.state_counts.NOT_ASSESSABLE ?? 0)} observations; not counted as correct.</p></li>)}</ul> : <p className="mt-3 text-sm text-muted">{receivedCount ? 'Every received check had at least one measured verdict.' : 'Keep the whole athlete visible, select the matching camera view, perform the selected movement, then return to the starting position and pause briefly.'}</p>}
        {!!unobserved.length && <div className="mt-3 rounded-xl border border-border p-3" data-testid="session-review-unobserved"><p className="text-sm font-medium">No assessment received for {unobserved.length} planned checks</p><p className="mt-1 text-sm capitalize text-muted">{unobserved.map(check => check.name).join(', ')}.</p><p className="mt-2 text-xs leading-relaxed text-subtle">These checks have no verdict. Check the recording availability and camera setup before the next attempt.</p></div>}
      </div>
    </div>
  </section>;
}
