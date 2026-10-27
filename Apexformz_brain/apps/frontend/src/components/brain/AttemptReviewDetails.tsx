import type { AssessmentSet } from '@apexformz/contracts';
import { criterionFeedbackLabel, dynamicReferencePresentation, isDynamicReferenceCriterion, type VisualFeedbackContext } from '@apexformz/brain-client';
import { observationForReview, reviewMissingExplanation } from '@/lib/brain/sessionTechniqueReview';

/** Past-attempt text only. These measurements never drive current body colors. */
export function AttemptReviewDetails({ assessment, context }: { assessment: AssessmentSet; context: VisualFeedbackContext }) {
  const rank = { IMPROVE: 0, PASS: 1, UNCERTAIN: 2, NOT_ASSESSABLE: 2, NOT_APPLICABLE: 3 };
  const criteria = assessment.criteria.filter(c => c.state !== 'NOT_APPLICABLE').sort((a, b) => rank[a.state] - rank[b.state] || Number(isDynamicReferenceCriterion(b)) - Number(isDynamicReferenceCriterion(a)));
  const passed = criteria.filter(c => c.state === 'PASS').length;
  const corrections = criteria.filter(c => c.state === 'IMPROVE').length;
  const recorded = criteria.some(isDynamicReferenceCriterion);
  return <div className="mt-3 space-y-2" data-testid="dynamic-attempt-checks">
    <p className="text-xs text-white/70">{recorded ? 'Within recorded range' : 'In range'}: {passed} · Adjustments: {corrections} · Unassessed: {criteria.length - passed - corrections}</p>
    <details className="rounded border border-white/10 p-2">
      <summary className="text-xs font-medium text-white/80 cursor-pointer">View {criteria.length} checks from this attempt</summary>
      <div className="mt-2 max-h-56 overflow-y-auto overscroll-contain space-y-2 pr-1 custom-scrollbar" tabIndex={0} role="region" aria-label="Attempt comparison details">
    {criteria.map(c => {
      const observation = observationForReview(c, context);
      const reference = dynamicReferencePresentation(c);
      return <div key={c.criterion_id} className="rounded border border-white/10 px-2 py-1.5 text-xs">
        <p className="font-medium text-white/90">{criterionFeedbackLabel(c)} · {c.state === 'PASS' ? isDynamicReferenceCriterion(c) ? 'Within recorded range' : 'In range' : c.state === 'IMPROVE' ? 'Adjust next attempt' : 'Not measured reliably'}</p>
        {reference?.phase_label && <p className="mt-1 text-white/60">Reference position: {reference.phase_label}. This is an alignment estimate.</p>}
        {c.state === 'IMPROVE' ? <><p className="mt-1 text-amber-200">{observation.correction}</p>{!!observation.body_areas.length && <p className="mt-1 capitalize text-white/60">{observation.body_areas.join(', ')}</p>}</> : c.state !== 'PASS' && <p className="mt-1 text-white/65">{reviewMissingExplanation(observation)}</p>}
      </div>;
    })}
      </div>
    </details>
  </div>;
}
