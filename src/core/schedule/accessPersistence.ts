/**
 * Close the one dangerous gap in schedule creation: the server returns a
 * bearer manage token only once, so any create that is not confirmed as
 * account-owned must not outlive a failed attempt to persist that token.
 *
 * Current web creates require sign-in and remain manageable through the
 * account's server-side list, so blocked browser storage is degraded-but-safe.
 * The non-owner branch is defense in depth for stale/future callers: cancel
 * immediately with the still-in-memory token, or return an explicit recovery
 * state so the UI does not silently orphan the post.
 */

import { cancelSchedule, type CancelResult } from "./api";
import { rememberSchedule, type LocalSchedule } from "./localStore";

export type ScheduleAccessOutcome =
  | { kind: "persisted" }
  | { kind: "account-owned" }
  | { kind: "rolled-back" }
  | { kind: "recovery-required"; rollbackError: string };

interface ScheduleAccessDependencies {
  remember?: (entry: LocalSchedule) => boolean;
  cancel?: (id: string, manageToken: string) => Promise<CancelResult>;
}

export async function preserveCreatedScheduleAccess(
  entry: LocalSchedule,
  accountOwned: boolean,
  dependencies: ScheduleAccessDependencies = {},
): Promise<ScheduleAccessOutcome> {
  const remember = dependencies.remember ?? rememberSchedule;
  try {
    if (remember(entry)) return { kind: "persisted" };
  } catch {
    // Custom storage implementations can still throw despite the production
    // local store's defensive API. Treat that exactly like a rejected write.
  }

  if (accountOwned) return { kind: "account-owned" };

  const cancel = dependencies.cancel ?? cancelSchedule;
  let rollback: CancelResult;
  try {
    rollback = await cancel(entry.id, entry.manageToken);
  } catch {
    return {
      kind: "recovery-required",
      rollbackError: "Couldn't reach the scheduling service to cancel it.",
    };
  }
  if (rollback.ok) return { kind: "rolled-back" };
  return { kind: "recovery-required", rollbackError: rollback.error };
}
