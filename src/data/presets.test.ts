/**
 * Contract tests for the shipped template catalogue.
 *
 * A template is the first thing a new user loads, so a malformed one is a bad
 * first impression that no amount of later polish undoes. Two failure modes are
 * silent enough to reach production without these:
 *
 *  - **An invalid message.** The editor shows validation errors the moment the
 *    template lands, on content the user didn't write.
 *  - **A `pluginSlots` entry whose `customId` matches nothing.** The guided setup
 *    resolves each slot to a live component by that id (`targetableNodeByCustomId`);
 *    a typo means the slot silently never finds its component, so the plugin is
 *    never offered and the template's button stays dead — with no error anywhere.
 */

import { describe, expect, it } from "vitest";

import { getPlugins, LINK_PLUGINS } from "@/core/plugins/registry";
import { presetsForTarget, targetableNodeByCustomId } from "@/core/plugins/targets";
import { linkUrlPrefix } from "@/core/plugins/linkManifest";
import { validateMessage } from "@/core/schema/validation";
import { ButtonStyle, type AnyComponent, type WebhookMessage } from "@/core/schema/types";
import { TEMPLATES } from "./presets";

/** Every node in a message, flattened. */
function walk(message: WebhookMessage): AnyComponent[] {
  const out: AnyComponent[] = [];
  const visit = (node: AnyComponent): void => {
    out.push(node);
    const record = node as unknown as Record<string, unknown>;
    if (Array.isArray(record.components)) {
      for (const child of record.components) visit(child as AnyComponent);
    }
    if (record.accessory) visit(record.accessory as AnyComponent);
  };
  for (const top of message.components) visit(top);
  return out;
}

describe("template catalogue", () => {
  it("ships at least the templates the gallery advertises", () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  it("gives every template a unique id", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The headline check: nothing ships that the editor would flag for a reason the
   * user can't act on.
   *
   * `BUTTON_LINK_URL_UNFINISHED` is deliberately allowed. A link-plugin template
   * ships a URL with a `{token}` the user must paste their own value over, and the
   * validator blocking send while it's raw is the *designed* behaviour — that's
   * the "fill-me slot" contract, not a broken template. Every other error is a
   * defect in the catalogue.
   */
  const INTENTIONAL_ERRORS = new Set(["BUTTON_LINK_URL_UNFINISHED"]);

  it("every template is a valid message, bar the deliberate fill-me slots", () => {
    const broken = TEMPLATES.map((t) => ({
      id: t.id,
      issues: validateMessage(t.message)
        .issues.filter((i) => i.severity === "error" && !INTENTIONAL_ERRORS.has(i.code))
        .map((i) => `${i.code}: ${i.message}`),
    })).filter((t) => t.issues.length > 0);
    expect(broken).toEqual([]);
  });

  describe("plugin slots", () => {
    const withSlots = TEMPLATES.filter((t) => (t.pluginSlots?.length ?? 0) > 0);

    it("has templates that declare slots (otherwise these tests prove nothing)", () => {
      expect(withSlots.length).toBeGreaterThan(0);
    });

    /**
     * A slot's `customId` must resolve to a real targetable component, or the
     * guided setup silently skips it and the template's button never gets wired.
     */
    it("resolves every interactive slot to a component in its own message", () => {
      const unresolved: string[] = [];
      for (const template of withSlots) {
        for (const slot of template.pluginSlots ?? []) {
          if (slot.kind === "link") continue;
          if (!targetableNodeByCustomId(template.message, slot.customId)) {
            unresolved.push(`${template.id} → ${slot.customId}`);
          }
        }
      }
      expect(unresolved).toEqual([]);
    });

    it("names a plugin that exists in the registry, for the target it is attached to", () => {
      const plugins = getPlugins();
      const problems: string[] = [];
      for (const template of withSlots) {
        for (const slot of template.pluginSlots ?? []) {
          if (slot.kind === "link") continue;
          const found = targetableNodeByCustomId(template.message, slot.customId);
          if (!found) continue; // already reported above
          const manifest = plugins.find((p) => p.id === slot.pluginId);
          if (!manifest) {
            problems.push(`${template.id} → unknown plugin ${slot.pluginId}`);
            continue;
          }
          if (!manifest.targets.includes(found.target)) {
            problems.push(
              `${template.id} → ${slot.pluginId} does not support ${found.target} (slot ${slot.customId})`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
    });

    /**
     * A slot may name a plugin preset to pre-apply. An unknown id is ignored by
     * the host, so the config just opens blank — the template silently loses the
     * setup it promised. It must exist *and* apply to that component's target.
     */
    it("names only presets the plugin declares for that target", () => {
      const plugins = getPlugins();
      const problems: string[] = [];
      for (const template of withSlots) {
        for (const slot of template.pluginSlots ?? []) {
          if (slot.kind === "link" || !slot.preset) continue;
          const found = targetableNodeByCustomId(template.message, slot.customId);
          const manifest = plugins.find((p) => p.id === slot.pluginId);
          if (!found || !manifest) continue;
          const available = presetsForTarget(manifest, found.target).map((p) => p.id);
          if (!available.includes(slot.preset)) {
            problems.push(
              `${template.id} → ${slot.pluginId} has no preset "${slot.preset}" for ${found.target} (has: ${available.join(", ") || "none"})`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
    });

    /** A link slot is resolved by URL prefix, so some Link button must carry it.
     *  Link manifests live in their own registry — `getPlugins()` returns only the
     *  interactive ones. */
    it("resolves every link slot to a Link button carrying that plugin's URL", () => {
      const plugins = LINK_PLUGINS;
      const unresolved: string[] = [];
      for (const template of withSlots) {
        for (const slot of template.pluginSlots ?? []) {
          if (slot.kind !== "link") continue;
          const manifest = plugins.find((p) => p.id === slot.pluginId);
          if (!manifest?.url) {
            unresolved.push(`${template.id} → unknown link plugin ${slot.pluginId}`);
            continue;
          }
          const prefix = linkUrlPrefix(manifest.url);
          const hit = walk(template.message).some((node) => {
            const record = node as unknown as Record<string, unknown>;
            return (
              record.style === ButtonStyle.Link &&
              typeof record.url === "string" &&
              record.url.startsWith(prefix)
            );
          });
          if (!hit) unresolved.push(`${template.id} → no Link button for ${slot.pluginId}`);
        }
      }
      expect(unresolved).toEqual([]);
    });

    /** `pairsWith` is the gallery's display summary of the same slots. */
    it("declares pairsWith whenever it declares slots", () => {
      const missing = withSlots.filter((t) => !t.pairsWith?.trim()).map((t) => t.id);
      expect(missing).toEqual([]);
    });
  });

  /**
   * The Staff directory template exists to demonstrate the Directory plugin's
   * in-message output, which only works if the message actually carries the
   * token — the service refuses to save that output shape without one.
   */
  describe("staff-directory", () => {
    const template = TEMPLATES.find((t) => t.id === "staff-directory");

    it("is in the catalogue", () => {
      expect(template).toBeDefined();
    });

    it("carries the {directory} token its in-message slot requires", () => {
      const text = walk(template!.message)
        .map((n) => (n as unknown as Record<string, unknown>).content)
        .filter((c): c is string => typeof c === "string")
        .join("\n");
      expect(text).toContain("{directory}");
    });

    /** The in-message slot must be a BUTTON — the plugin refuses a menu. */
    it("attaches its in-message slot to a button", () => {
      const slot = template!.pluginSlots?.find(
        (s) => s.kind !== "link" && s.preset?.includes("inline"),
      );
      expect(slot).toBeDefined();
      const found = targetableNodeByCustomId(
        template!.message,
        (slot as { customId: string }).customId,
      );
      expect(found?.target).toBe("button");
    });
  });
});
