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
