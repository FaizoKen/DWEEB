import { useEffect, useMemo } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { usePluginRegistry } from "@/core/state/pluginRegistryStore";
import { isPluginRegistryConfigured } from "@/core/plugins/registry";
import { messagePlaceholders } from "@/core/plugins/placeholders";
import { LIMITS } from "@/core/schema/limits";
import type { TextDisplayComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { MarkdownTextArea } from "@/ui/MarkdownTextArea";

interface Props {
  node: TextDisplayComponent;
}

export function TextDisplayInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);

  // Offer a `{}` insert dropdown of the placeholders available to this message,
  // grouped by provider: the core server/channel tokens (always) plus any an
  // attached plugin declares (e.g. Giveaway's `{prize}` / `{winners}`).
  const message = useMessageStore((s) => s.message);
  const plugins = usePluginRegistry((s) => s.plugins);
  const loadPlugins = usePluginRegistry((s) => s.load);
  useEffect(() => {
    if (isPluginRegistryConfigured()) loadPlugins();
  }, [loadPlugins]);
  const placeholders = useMemo(() => messagePlaceholders(message, plugins), [message, plugins]);

  return (
    <Field
      label="Content"
      hint={`Markdown supported. ${node.content.length}/${LIMITS.TEXT_DISPLAY_CONTENT}`}
    >
      {(id) => (
        <MarkdownTextArea
          id={id}
          value={node.content}
          maxLength={LIMITS.TEXT_DISPLAY_CONTENT}
          rows={8}
          onChange={(content) => patch<TextDisplayComponent>(node._id, { content })}
          placeholder="Write your message…"
          placeholders={placeholders}
        />
      )}
    </Field>
  );
}
