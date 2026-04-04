/**
 * Dependency Cascade — traverse the decision graph downstream
 * when an upstream decision is superseded or reverted, and flag
 * every dependent decision.
 */

import { getDb } from '../db/index.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CascadeImpact {
  decision_id: string;
  decision_title: string;
  depth: number;
  path: string[];
  impact: 'direct' | 'transitive';
  affected_agents: string[];
}

export interface CascadeResult {
  changed_decision_id: string;
  changed_decision_title: string;
  impacts: CascadeImpact[];
  total_affected: number;
}

// ---------------------------------------------------------------------------
// Core traversal
// ---------------------------------------------------------------------------

/**
 * Find all downstream decisions that depend on (require) the changed decision.
 *
 * Uses BFS through "requires" edges — finds decisions whose source_id points
 * to the changed decision via a "requires" relationship, then their dependents,
 * up to `maxDepth`.
 *
 * "requires" edge semantics: source_id REQUIRES target_id.
 * So if B requires A, the edge is (source=B, target=A).
 * When A changes, B is affected.
 * To find B given A: SELECT source_id FROM decision_edges WHERE target_id = A AND relationship = 'requires'
 */
export async function findCascadeImpact(
  changedDecisionId: string,
  projectId: string,
  maxDepth: number = 5,
): Promise<CascadeResult> {
  const db = getDb();

  // Fetch the changed decision's title
  const changedResult = await db.query<{ title: string }>(
    'SELECT title FROM decisions WHERE id = ?',
    [changedDecisionId],
  );
  const changedTitle = changedResult.rows[0]?.title ?? 'Unknown';

  const impacts: CascadeImpact[] = [];
  const visited = new Set<string>();
  visited.add(changedDecisionId);

  // BFS queue: [decisionId, depth, path of titles]
  const queue: Array<[string, number, string[]]> = [[changedDecisionId, 0, [changedTitle]]];

  while (queue.length > 0) {
    const [currentId, currentDepth, currentPath] = queue.shift()!;

    if (currentDepth >= maxDepth) continue;

    // Find decisions that REQUIRE currentId
    // Edge: source_id=dependent, target_id=currentId, relationship='requires'
    const dependents = await db.query<{
      id: string;
      title: string;
      affects: unknown;
    }>(
      `SELECT d.id, d.title, d.affects
       FROM decision_edges e
       JOIN decisions d ON e.source_id = d.id
       WHERE e.target_id = ? AND e.relationship = 'requires' AND d.project_id = ?`,
      [currentId, projectId],
    );

    for (const dep of dependents.rows) {
      if (visited.has(dep.id)) continue;
      visited.add(dep.id);

      // Parse affects
      let affects: string[] = [];
      if (Array.isArray(dep.affects)) {
        affects = dep.affects as string[];
      } else if (typeof dep.affects === 'string') {
        try { affects = JSON.parse(dep.affects); } catch { affects = []; }
      }

      const newPath = [...currentPath, dep.title];
      const depth = currentDepth + 1;

      impacts.push({
        decision_id: dep.id,
        decision_title: dep.title,
        depth,
        path: newPath,
        impact: depth === 1 ? 'direct' : 'transitive',
        affected_agents: affects,
      });

      // Continue BFS
      queue.push([dep.id, depth, newPath]);
    }
  }

  return {
    changed_decision_id: changedDecisionId,
    changed_decision_title: changedTitle,
    impacts,
    total_affected: impacts.length,
  };
}

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

/**
 * Create cascade notifications for all affected agents and governors.
 */
export async function notifyCascade(
  cascade: CascadeResult,
  projectId: string,
  eventVerb: string = 'superseded',
): Promise<void> {
  if (cascade.impacts.length === 0) return;
  const db = getDb();

  // 1. Notify affected agents for each impacted decision
  for (const impact of cascade.impacts) {
    for (const agentName of impact.affected_agents) {
      // Find agent ID by name
      const agentResult = await db.query<{ id: string }>(
        'SELECT id FROM agents WHERE project_id = ? AND name = ?',
        [projectId, agentName],
      );
      if (agentResult.rows.length === 0) continue;
      const agentId = agentResult.rows[0].id;

      const message = `"${impact.decision_title}" depends on "${cascade.changed_decision_title}" which was just ${eventVerb}. Review if "${impact.decision_title}" is still valid.`;

      try {
        await db.query(
          `INSERT INTO notifications (id, agent_id, decision_id, notification_type, message, urgency)
           VALUES (?, ?, ?, 'dependency_changed', ?, ?)`,
          [
            randomUUID(),
            agentId,
            impact.decision_id,
            message,
            impact.depth === 1 ? 'high' : 'medium',
          ],
        );
      } catch (err) {
        console.warn(`[nexus:cascade] Notification failed for agent "${agentName}": ${(err as Error).message}`);
      }
    }
  }

  // 2. Notify all governors
  const governors = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM agents WHERE project_id = ? AND role = 'governor'",
    [projectId],
  );

  const chainSummary = cascade.impacts
    .map((i) => `  ${i.depth === 1 ? '→' : '  →'} "${i.decision_title}" (depth ${i.depth}, ${i.impact})`)
    .join('\n');

  const governorMessage = `"${cascade.changed_decision_title}" was ${eventVerb}. ${cascade.total_affected} downstream decision(s) affected:\n${chainSummary}`;

  for (const gov of governors.rows) {
    try {
      await db.query(
        `INSERT INTO notifications (id, agent_id, decision_id, notification_type, message, urgency)
         VALUES (?, ?, ?, 'dependency_changed', ?, 'critical')`,
        [randomUUID(), gov.id, cascade.changed_decision_id, governorMessage],
      );
    } catch (err) {
      console.warn(`[nexus:cascade] Governor notification failed for "${gov.name}": ${(err as Error).message}`);
    }
  }

  console.warn(
    `[nexus:cascade] ${cascade.changed_decision_title} ${eventVerb} — ${cascade.total_affected} downstream decisions affected`,
  );
}
