/**
 * Followed-pipeline helpers.
 *
 * `pipelines.is_tracked` is the "followed" flag: syncs mirror EVERY pipeline
 * (cheap, keeps history), but only followed ones drive dashboards, metrics,
 * digests and the unmapped-stage warnings. Jake names retired pipelines
 * "{ Off } ..." — those sort to the bottom of Setup and are never suggested
 * for following (a human can still follow one explicitly).
 */

export function isOffPipeline(name: string): boolean {
  return /^\s*\{\s*off\s*\}/i.test(name);
}

/**
 * Phase G: the funnel is the "[new] Application Pipeline" only. New pipeline
 * rows are followed on first sight iff they are this one (migration 0005
 * applied the same rule to rows that already existed). A human can still
 * follow/unfollow anything in Setup.
 */
export const DEFAULT_FOLLOWED_PIPELINE_ID = 'UR5P3vNTm9VPuYZFrb6c';
export const DEFAULT_FOLLOWED_PIPELINE_NAME = '[new] Application Pipeline';

export function isDefaultFollowedPipeline(id: string): boolean {
  return id === DEFAULT_FOLLOWED_PIPELINE_ID;
}
