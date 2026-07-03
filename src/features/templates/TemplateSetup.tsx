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
 *
 * **Link slots** (`kind: "link"`) walk the same checklist with an inverted
 * job: the binding already ships inside the button's URL, so there is nothing
 * to configure in DWEEB — what remains is the *external service's* per-server
 * setup (its `setupUrl`). The row's "Set up" simply opens that dashboard in a
 * new tab and the slot counts as ready; DWEEB can't observe the service's
 * state, so opening the page is the whole step (held in local state, never
 * persisted). A link plugin with no `setupUrl` needs nothing and starts ready.
 */

import { useEffect, useMemo, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { getPluginSummary, setPluginSummary } from "@/core/state/pluginSummaryCache";
import { getPlugins, LINK_PLUGINS } from "@/core/plugins/registry";
import {
  componentIdentity,
  interactiveComponents,
  linkButtonNodeByPlugin,
  targetableNodeByCustomId,
  targetNoun,
  type PluginTarget,
} from "@/core/plugins/targets";
import { TEMPLATES } from "@/data/presets";
import type { EditorId, StringSelectComponent } from "@/core/schema/types";
import type { PluginManifest } from "@/core/plugins/manifest";
import type { LinkPluginManifest } from "@/core/plugins/linkManifest";
import { PluginConfigModal } from "@/features/plugins/PluginConfigModal";
import { PluginIcon } from "@/features/plugins/PluginIcon";
import type { PluginSaveResult } from "@/features/plugins/usePluginConfig";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { CheckCircleIcon, ChevronRightIcon, ExternalLinkIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { useTemplateSetupStore } from "./templateSetupStore";
import styles from "./TemplateSetup.module.css";

/** Sentence-case a noun for use as a row title fallback ("channel menu" → "Channel menu"). */
const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** One resolved slot: a live interactive component + the plugin to wire it to. */
interface InteractiveSlot {
  kind: "interactive";
  manifest: PluginManifest;
  nodeId: EditorId;
  target: PluginTarget;
  /** Manifest preset id to pre-apply when setting this slot up fresh, if any. */
  preset?: string;
}

/** A pre-wired Link button whose external service needs per-server setup. */
interface LinkSlot {
  kind: "link";
  manifest: LinkPluginManifest;
  nodeId: EditorId;
}

type Slot = InteractiveSlot | LinkSlot;

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
    return template.pluginSlots.flatMap((slot): Slot[] => {
      if (slot.kind === "link") {
        // A link slot names only the plugin — the live component is the Link
        // button already carrying that plugin's URL (the template ships it
        // pre-wired), found by prefix rather than custom_id.
        const manifest = LINK_PLUGINS.find((p) => p.id === slot.pluginId);
        if (!manifest) return [];
        const nodeId = linkButtonNodeByPlugin(msg, manifest);
        if (!nodeId) return [];
        return [{ kind: "link", manifest, nodeId }];
      }
      const manifest = getPlugins().find((p) => p.id === slot.pluginId);
      if (!manifest) return [];
      const found = targetableNodeByCustomId(msg, slot.customId);
      if (!found) return [];
      return [
        {
          kind: "interactive",
          manifest,
          nodeId: found.nodeId,
          target: found.target,
          ...(slot.preset ? { preset: slot.preset } : {}),
        },
      ];
    });
  }, [template]);

  // Which slot's config UI is open (index into `slots`), or null for checklist.
  const [configuring, setConfiguring] = useState<number | null>(null);

  // Link slots whose setup page was opened, keyed by slot index. A link
  // binding already ships in the button URL and DWEEB can't observe the
  // external service's per-server state, so launching its dashboard is the
  // whole step — local to this flow, never persisted.
  const [linkOpened, setLinkOpened] = useState<Record<number, boolean>>({});

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
    if (!slot) return false;
    // A link slot ships wired; ready = its setup page was opened (or there is
    // no setup page, so nothing is owed).
    if (slot.kind === "link") return !slot.manifest.setupUrl || !!linkOpened[i];
    return !!currentIdFor(i)?.startsWith(slot.manifest.customIdPrefix);
  };

  // Open the external service's per-server setup page for a link slot — that
  // one click is the slot's whole step.
  const openLinkSetup = (i: number) => {
    const slot = slots[i];
    if (!slot || slot.kind !== "link" || !slot.manifest.setupUrl) return;
    window.open(slot.manifest.setupUrl, "_blank", "noopener,noreferrer");
    setLinkOpened((s) => ({ ...s, [i]: true }));
  };

  const readyCount = slots.filter((_, i) => isReady(i)).length;
  const pending = slots.length - readyCount;
  const multi = slots.length > 1;
  // Captured for the single-slot lead copy so the union narrows properly.
  const first = slots[0];

  // Adopt what the plugin handed back — exactly like the inspector's Action
  // panel: the returned `custom_id` is the binding, plus (for a string select)
  // the option list and any manager-owned fields, and the per-binding guild for
  // the Send panel's wrong-server check.
  const handleSave = (i: number) => (result: PluginSaveResult) => {
    const slot = slots[i];
    if (!slot || slot.kind !== "interactive") return;
    const fields: Partial<StringSelectComponent> = { custom_id: result.customId };
    if (slot.target === "string_select" && result.options?.length) fields.options = result.options;
    if (result.fields) Object.assign(fields, result.fields);
    patchNode<StringSelectComponent>(slot.nodeId, fields);
    // Cache the summary, the per-binding guild, AND any static placeholder values
    // (e.g. Giveaway's `{prize}`) — mirroring the inspector's Action panel. Without
    // the values, a template configured here would render `{token}` text as the
    // manifest sample instead of the real value at first paint.
    if (result.summary || result.guildId || result.values) {
      const summary = result.summary ?? { label: slot.manifest.name };
      setPluginSummary(result.customId, slot.manifest.id, summary, result.guildId, result.values);
    }
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
    // Only interactive slots open a config UI; a link slot's setup lives on the
    // external service, so `setConfiguring` is never called for one.
    if (!slot || slot.kind !== "interactive") return null;
    const ready = isReady(configuring);
    return (
      <PluginConfigModal
        manifest={slot.manifest}
        target={slot.target}
        customId={ready ? currentIdFor(configuring) : undefined}
        // Pre-fill from the template's preset only on a fresh setup; a reconfigure
        // loads the saved binding instead.
        preset={ready ? undefined : slot.preset}
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
            This template has <strong>{slots.length}</strong> actions to finish. Connect each one
            below and they'll work the moment you post — no hunting through the editor.
          </>
        ) : first?.kind === "link" ? (
          <>
            This template's button links to <strong>{first.manifest.name}</strong>, an external
            service. Set it up for your server once and the link works the moment you post — there's
            nothing to configure in DWEEB.
          </>
        ) : (
          <>
            This template includes an interactive {first?.target === "button" ? "button" : "menu"}.
            Connect it to its plugin and it'll respond the moment you post — no hunting through the
            editor.
          </>
        )}
      </p>

      <ul className={styles.slotList}>
        {slots.map((slot, i) => {
          const ready = isReady(i);
          const isLink = slot.kind === "link";
          const cached = ready && !isLink ? getPluginSummary(currentIdFor(i)) : undefined;
          const noun = isLink ? "link button" : targetNoun(slot.target);
          // The component's own identity — its visible placeholder/label and the
          // heading above it — is what tells four "Picker" rows apart: it names
          // which part of the message this slot wires, in the user's own words.
          const ident = componentIdentity(message, slot.nodeId);
          const title = ident.label ?? (multi ? `${capitalize(noun)} ${i + 1}` : capitalize(noun));
          // Description: where in the message it sits (or the plugin's purpose)
          // until wired; what it'll do once connected. A link slot leads with its
          // setup hint — the one thing standing between the button and working.
          const desc = isLink
            ? ready
              ? `The button links to ${slot.manifest.publisher ?? slot.manifest.name}'s service — finish any steps in the setup tab.`
              : (slot.manifest.setupHint ?? slot.manifest.description)
            : ready
              ? (cached?.summary.description ?? `Connected to this ${noun}.`)
              : (ident.context ?? slot.manifest.description);
          return (
            <li key={i} className={styles.slotRow} data-ready={ready ? "true" : undefined}>
              <PluginIcon manifest={slot.manifest} summaryIcon={cached?.summary.icon} />
              <div className={styles.slotText}>
                <span className={styles.slotName}>
                  <span className={styles.slotTitle}>{title}</span>
                  {/* Keep the plugin + kind visible — the icon shows which plugin,
                      this names the exact control it binds. */}
                  <span className={styles.slotNoun}>
                    · {slot.manifest.name} {noun}
                  </span>
                </span>
                {desc ? <span className={styles.slotDesc}>{desc}</span> : null}
              </div>
              <div className={styles.slotAction}>
                {ready ? (
                  <span className={styles.slotReady}>
                    <CheckCircleIcon size={15} aria-hidden /> Ready
                  </span>
                ) : null}
                {isLink ? (
                  // One click: launch the service's own dashboard in a new tab
                  // — DWEEB can't watch the external setup, so opening it is
                  // the whole step and the row flips to Ready.
                  slot.manifest.setupUrl ? (
                    <Button
                      size="sm"
                      variant={ready ? "ghost" : "primary"}
                      trailingIcon={<ExternalLinkIcon size={14} />}
                      onClick={() => openLinkSetup(i)}
                    >
                      {ready ? "Open setup" : "Set up"}
                    </Button>
                  ) : null
                ) : (
                  <Button
                    size="sm"
                    variant={ready ? "ghost" : "primary"}
                    onClick={() => setConfiguring(i)}
                  >
                    {ready ? "Reconfigure" : "Set up"}
                  </Button>
                )}
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
