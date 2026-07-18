/**
 * In-memory data that belongs to the current authenticated account.
 *
 * Feature stores register their own reset callback when their module is loaded.
 * The auth store can then release every loaded account-scoped cache without
 * importing those feature modules (and creating a web of circular imports).
 * A feature that was never loaded has no state to release.
 */

type AccountStateReset = () => void;

const resets = new Set<AccountStateReset>();

export function registerAccountStateReset(reset: AccountStateReset): () => void {
  resets.add(reset);
  return () => resets.delete(reset);
}

export function resetAccountScopedState(): void {
  for (const reset of resets) reset();
}
