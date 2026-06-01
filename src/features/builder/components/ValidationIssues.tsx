/**
 * Presentational pieces for surfacing validation issues in the editor.
 *
 *  - `IssueDot`  is the compact "this component has a problem" marker overlaid
 *    on a tree row's glyph. It carries the full message list in its tooltip so
 *    a mouse user can read everything without selecting the row.
 *  - `IssueList` is the readable breakdown shown at the top of an inspector (and
 *    in the meta header for message-level issues) — one line per problem, each
 *    coloured and iconed by severity so the fix is obvious.
 *
 * Both are driven by the issue list a caller pulls from `useNodeIssues`.
 */

import { cn } from "@/lib/cn";
import { AlertCircleIcon, AlertTriangleIcon } from "@/ui/Icon";
import type { ValidationIssue } from "@/core/schema/validation";
import { worstSeverity } from "../useValidation";
import styles from "./ValidationIssues.module.css";

/** Human label like "1 error, 2 warnings" for tooltips / screen readers. */
function countLabel(issues: ValidationIssue[]): string {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  return [
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : null,
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** A coloured status dot for a tree row's component glyph. */
export function IssueDot({ issues }: { issues: ValidationIssue[] }) {
  const severity = worstSeverity(issues);
  if (!severity) return null;
  const label = countLabel(issues);
  const tooltip = `${label}\n${issues.map((i) => `• ${i.message}`).join("\n")}`;
  return (
    <span
      className={cn(styles.dot, severity === "error" ? styles.dotError : styles.dotWarn)}
      title={tooltip}
      role="img"
      aria-label={label}
    />
  );
}

/** Full, readable list of issues — shown at the top of an inspector. */
export function IssueList({
  issues,
  className,
}: {
  issues: ValidationIssue[];
  className?: string;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn(styles.list, className)}>
      {issues.map((issue, i) => (
        <li
          key={`${issue.code}-${i}`}
          className={cn(
            styles.item,
            issue.severity === "error" ? styles.itemError : styles.itemWarn,
          )}
        >
          <span className={styles.itemIcon} aria-hidden="true">
            {issue.severity === "error" ? (
              <AlertCircleIcon size={15} />
            ) : (
              <AlertTriangleIcon size={15} />
            )}
          </span>
          <span className={styles.itemText}>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}
