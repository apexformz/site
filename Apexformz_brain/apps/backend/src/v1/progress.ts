/**
 * Athlete progress aggregation (TRD 11/13): scores are only aggregated within
 * one rubric version; incompatible versions are reported side by side.
 */
export interface AssessmentRow {
  session_id: string;
  movement_id: string;
  criterion_id: string;
  status: string;
  score: number | null;
  rubric_version: string;
  created_at: Date;
}

export interface SessionRow {
  id: string;
  movement_id: string;
  sport_id: string;
  pack_version: string;
  started_at: Date;
  ended_at: Date | null;
  status: string;
}

export interface MovementProgress {
  movement_id: string;
  sport_id: string;
  sessions: number;
  last_session_at: string | null;
  criterion_state_counts: Record<string, number>;
  by_rubric_version: Record<string, { criteria_scored: number; mean_score: number | null }>;
}

export function aggregateProgress(sessions: SessionRow[], assessments: AssessmentRow[]): MovementProgress[] {
  const byMovement = new Map<string, MovementProgress>();
  const sessionMovement = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    let m = byMovement.get(s.movement_id);
    if (!m) {
      m = { movement_id: s.movement_id, sport_id: s.sport_id, sessions: 0, last_session_at: null, criterion_state_counts: {}, by_rubric_version: {} };
      byMovement.set(s.movement_id, m);
    }
    m.sessions++;
    const at = (s.ended_at ?? s.started_at).toISOString();
    if (!m.last_session_at || at > m.last_session_at) m.last_session_at = at;
  }
  const sums = new Map<string, { n: number; sum: number }>();
  for (const a of assessments) {
    const s = sessionMovement.get(a.session_id);
    const m = s ? byMovement.get(s.movement_id) : undefined;
    if (!m) continue;
    m.criterion_state_counts[a.status] = (m.criterion_state_counts[a.status] ?? 0) + 1;
    if (a.score !== null && (a.status === 'PASS' || a.status === 'IMPROVE')) {
      const key = `${m.movement_id}|${a.rubric_version}`;
      const cur = sums.get(key) ?? { n: 0, sum: 0 };
      cur.n++;
      cur.sum += a.score;
      sums.set(key, cur);
    }
    if (!m.by_rubric_version[a.rubric_version]) m.by_rubric_version[a.rubric_version] = { criteria_scored: 0, mean_score: null };
  }
  for (const [key, v] of sums) {
    const [movementId, rubric] = key.split('|');
    const m = byMovement.get(movementId)!;
    m.by_rubric_version[rubric] = { criteria_scored: v.n, mean_score: v.n ? v.sum / v.n : null };
  }
  return [...byMovement.values()];
}
