/** Revision belongs to the document, so compare it across version IDs as well. */
export function latestDocument<
  T extends { id: string; summary_revision: number },
>(current: T | null, incoming: T): T {
  return current?.id === incoming.id &&
    current.summary_revision > incoming.summary_revision
    ? current
    : incoming;
}
