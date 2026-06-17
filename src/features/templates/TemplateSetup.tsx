/**
 * Guided template setup — the step that runs right after a user picks an
 * interactive template from the gallery.
 *
 * An interactive template ships one *or more* buttons/menus carrying a
 * placeholder `custom_id` that doesn't match any plugin yet. Before this flow
 * existed, the user had to find each component in the tree, open its Action
 * panel, browse the plugin library, pick the right one, and configure it — a
 * lot of hunting for something the template already knows (its `pluginSlots`).
 *
 * This collapses all of that into one checklist:
 *  - Each declared slot resolves to a live component + its paired plugin and
 *    shows as a row with a "Set up" button.
 *  - "Set up" opens the plugin's own config UI (the same `PluginConfigModal`
 *    the inspector uses) and writes the returned `custom_id` (plus any managed
 *    options/fields) straight onto that component, so the binding is live
 *    without the user touching the tree. The row flips to "Ready".
 *  - A template can pair several plugins (verify → Quick Replies, roles →
 *    Self Role…); the checklist tracks each independently — set up all, some, or
 *    none, in any order.
 *  - "Review in editor" closes the modal so the editor's live preview is front
 *    and centre, and an actionable toast asks from there — its "Post" button
 *    raises the setup store's send signal, which `App` turns into the Send
 *    dialog. The question lives in the editor, not behind another modal.
 *
 * "Ready" is derived from the live message (a slot is wired once its
 * component's `custom_id` carries the plugin's prefix), so saves and
 * reconfigures reflect instantly. Anything left unwired stays exactly where the
 * old flow started, reachable later from the Action panel. Mounted by `App` as
 * a peer of the Share dialog (not nested in the gallery portal), keyed off
 * `templateSetupStore`.
 */

import { useEffect, useMemo, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { getPluginSummary, setPluginSummary } from "@/core/state/pluginSummaryCache";
import { getPlugins } from "@/core/plugins/registry";
import {
  interactiveComponents,
  targetableNodeByCustomId,
  type PluginTarget,
} from "@/core/plugins/targets";
import { TEMPLATES } from "@/data/presets";
import type { EditorId, StringSelectComponent } from "@/core/schema/types";
import type { PluginManifest } from "@/core/plugins/manifest";
import { PluginConfigModal } from "@/features/plugins/PluginConfigModal";
import { PluginIcon } from "@/features/plugins/PluginIcon";
import type { PluginSaveResult } from "@/features/plugins/usePluginConfig";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { CheckCircleIcon, ChevronRightIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { useTemplateSetupStore } from "./templateSetupStore";
import styles from "./TemplateSetup.module.css";

/** One resolved slot: a live component paired with the plugin to wire it to. */
interface Slot {
  manifest: PluginManifest;
  nodeId: EditorId;
  target: PluginTarget;
}

export function TemplateSetup({ templateId }: { templateId: string }) {
  const close = useTemplateSetupStore((s) => s.close);
  const nudgeToSend = useSendNudgeStore((s) => s.nudge);
  const patchNode = useMessageStore((s) => s.patchNode);
  const message = useMessageStore((s) => s.message);

  const template = useMemo(() => TEMPLATES.find((t) => t.id === templateId), [templateId]);

  // Resolve every declared slot to a live component — once, from the message the
  // gallery just applied. Editor ids are stable for the life of this flow (the
  // editor sits behind the modal), and the placeholder custom_ids survive
  // `replaceMessage`, so this mapping holds even as we rewrite ids on save.
  // Slots whose plugin or component can't be found are dropped, never guessed.
  const slots = useMemo<Slot[]>(() => {
    if (!template?.pluginSlots?.length) return [];
    const msg = useMessageStore.getState().message;
    return template.pluginSlots.flatMap((slot) => {
      const manifest = getPlugins().find((p) => p.id === slot.pluginId);
      if (!manifest) return [];
      const found = targetableNodeByCustomId(msg, slot.customId);
      if (!found) return [];
      return [{ manifest, nodeId: found.nodeId, target: found.target }];
    });
  }, [template]);

  // Which slot's config UI is open (index into `slots`), or null for checklist.
  const [configuring, setConfiguring] = useState<number | null>(null);

  // Nothing to wire (registry gone / unknown plugins / no matching components) —
  // bail out; the template is already applied to the editor.
  useEffect(() => {
    if (slots.length === 0) close();
  }, [slots.length, close]);
  if (slots.length === 0) return null;

  // Live custom_id per editor id, recomputed when the message changes — the
  // source of truth for "is this slot wired yet". A slot is ready once its
  // component's custom_id carries the plugin's prefix (i.e. it's configured).
  const idToCustom = new Map(interactiveComponents(message).map((n) => [n.nodeId, n.customId]));
  const currentIdFor = (i: number) => {
    const slot = slots[i];
    return slot ? idToCustom.get(slot.nodeId) : undefined;
  };
  const isReady = (i: number) => {
    const slot = slots[i];
    return !!slot && !!currentIdFor(i)?.startsWith(slot.manifest.customIdPrefix);
  };

  const readyCount = slots.filter((_, i) => isReady(i)).length;
  const pending = slots.length - readyCount;
  const multi = slots.length > 1;

  // Adopt what the plugin handed back — exactly like the inspector's Action
  // panel: the returned `custom_id` is the binding, plus (for a string select)
  // the option list and any manager-owned fields, and the per-binding guild for
  // the Send panel's wrong-server check.
  const handleSave = (i: number) => (result: PluginSaveResult) => {
    const slot = slots[i];
    if (!slot) return;
    const fields: Partial<StringSelectComponent> = { custom_id: result.customId };
    if (slot.target === "string_select" && result.options?.length) fields.options = result.options;
    if (result.fields) Object.assign(fields, result.fields);
    patchNode<StringSelectComponent>(slot.nodeId, fields);
    if (result.summary)
      setPluginSummary(result.customId, slot.manifest.id, result.summary, result.guildId);
    setConfiguring(null);
  };

  const handleDismiss = () => {
    if (pending > 0) {
      pushToast(
        `Template added. Set up the remaining ${pending === 1 ? "action" : "actions"} anytime from ${
          pending === 1 ? "its" : "their"
        } Action panel.`,
        "info",
      );
    }
    close();
  };

  // Done connecting → step back to the editor and point the user at the Send
  // button with a coach-mark (and, on mobile, raise the preview sheet so the
  // message is visible) rather than holding the question inside a modal.
  const handleDone = () => {
    close();
    nudgeToSend();
  };

  // The plugin's own config UI. Cancelling returns to the checklist rather than
  // abandoning the whole flow, so a mis-click is recoverable. A wired slot
  // reconfigures (pass its current id); an unwired one attaches fresh.
  if (configuring !== null) {
    const slot = slots[configuring];
    if (!slot) return null;
    return (
      <PluginConfigModal
        manifest={slot.manifest}
        target={slot.target}
        customId={isReady(configuring) ? currentIdFor(configuring) : undefined}
        onSave={handleSave(configuring)}
        onClose={() => setConfiguring(null)}
      />
    );
  }

  return (
    <Modal
      open
      title={template ? `Set up ${template.name}` : "Finish setup"}
      onClose={handleDismiss}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" onClick={handleDismiss}>
            {pending > 0 ? "Skip & set up manually" : "Close"}
          </Button>
          <Button
            variant="primary"
            trailingIcon={<ChevronRightIcon size={16} />}
            onClick={handleDone}
            disabled={pending > 0}
            title={
              pending > 0
                ? `Connect ${
                    pending === 1 ? "the remaining action" : `all ${slots.length} actions`
                  } first, or skip to set them up manually.`
                : undefined
            }
          >
            Review in editor
          </Button>
        </div>
      }
    >
      {/* Three-step trail: template chosen (done), connect plugins (here), then
          review & post — which happens back in the editor once this closes. */}
      <ol className={styles.steps} aria-label="Setup progress">
        <li className={`${styles.step} ${styles.stepDone}`}>
          <span className={styles.stepMark} aria-hidden>
            <CheckCircleIcon size={16} />
          </span>
          Choose a template
        </li>
        <li className={`${styles.step} ${styles.stepCurrent}`} aria-current="step">
          <span className={styles.stepNum} aria-hidden>
            2
          </span>
          Connect {multi ? "the plugins" : "the plugin"}
          {multi ? (
            <span className={styles.stepPill}>
              {readyCount}/{slots.length}
            </span>
          ) : null}
        </li>
        <li className={styles.step}>
          <span className={styles.stepNum} aria-hidden>
            3
          </span>
          Review &amp; post
        </li>
      </ol>

      <p className={styles.lead}>
        {multi ? (
          <>
            This template has <strong>{slots.length}</strong> interactive components. Connect each
            to its plugin and they'll respond the moment you post — no hunting through the editor.
          </>
        ) : (
          <>
            This template includes an interactive{" "}
            {slots[0]?.target === "button" ? "button" : "menu"}. Connect it to its plugin and it'll
            respond the moment you post — no hunting through the editor.
          </>
        )}
      </p>

      <ul className={styles.slotList}>
        {slots.map((slot, i) => {
          const ready = isReady(i);
          const cached = ready ? getPluginSummary(currentIdFor(i)) : undefined;
          const noun = slot.target === "button" ? "button" : "menu";
          const desc = ready
            ? (cached?.summary.description ?? `Connected to this ${noun}.`)
            : slot.manifest.description;
          return (
            <li key={i} className={styles.slotRow} data-ready={ready ? "true" : undefined}>
              <PluginIcon manifest={slot.manifest} summaryIcon={cached?.summary.icon} />
              <div className={styles.slotText}>
                <span className={styles.slotName}>
                  {cached?.summary.label ?? slot.manifest.name}
                  <span className={styles.slotNoun}>· {noun}</span>
                </span>
                {desc ? <span className={styles.slotDesc}>{desc}</span> : null}
              </div>
              <div className={styles.slotAction}>
                {ready ? (
                  <span className={styles.slotReady}>
                    <CheckCircleIcon size={15} aria-hidden /> Ready
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant={ready ? "ghost" : "primary"}
                  onClick={() => setConfiguring(i)}
                >
                  {ready ? "Reconfigure" : "Set up"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className={styles.hint}>
        Connected actions work the moment you post. Anything you skip can be set up later from its
        Action panel.
      </p>
    </Modal>
  );
}
