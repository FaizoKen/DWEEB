import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import { countCharacters, countComponents } from "@/core/schema/traversal";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import styles from "./MessageMetaPanel.module.css";

export function MessageMetaPanel() {
  const username = useMessageStore((s) => s.message.username ?? "");
  const avatar = useMessageStore((s) => s.message.avatar_url ?? "");
  const message = useMessageStore((s) => s.message);
  const setUsername = useMessageStore((s) => s.setUsername);
  const setAvatar = useMessageStore((s) => s.setAvatarUrl);

  const characters = countCharacters(message);
  const components = countComponents(message);

  return (
    <div className={styles.panel}>
      <div className={styles.intro}>
        <h3 className={styles.title}>Webhook execution</h3>
        <p className={styles.sub}>
          These overrides ride along when the message is delivered. They don't appear in the
          payload's <code>components</code> block.
        </p>
      </div>

      <Field
        label="Username override"
        hint={`Max ${LIMITS.WEBHOOK_USERNAME} characters. Leave blank to use the webhook's default.`}
      >
        {(id) => (
          <TextInput
            id={id}
            value={username}
            maxLength={LIMITS.WEBHOOK_USERNAME}
            onChange={(e) => setUsername(e.currentTarget.value)}
            placeholder="e.g. Release Bot"
          />
        )}
      </Field>

      <Field label="Avatar URL override" hint="Must be a public https:// URL.">
        {(id) => (
          <TextInput
            id={id}
            type="url"
            value={avatar}
            onChange={(e) => setAvatar(e.currentTarget.value)}
            placeholder="https://…"
          />
        )}
      </Field>

      <div className={styles.stats}>
        <Stat label="Components" value={`${components} / ${LIMITS.TOTAL_COMPONENTS}`} />
        <Stat label="Characters" value={`${characters} / ${LIMITS.TOTAL_CHARACTERS}`} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
    </div>
  );
}
