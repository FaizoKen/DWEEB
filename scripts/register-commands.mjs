// Registers the app's global application commands: the /dashboard slash
// command plus the right-click context-menu commands. Run once; PUT replaces
// the full set, so re-running is idempotent.
//
// Usage (PowerShell):
//   $env:DISCORD_BOT_TOKEN = "your-bot-token"
//   node scripts/register-commands.mjs <applicationId>
//
// The dispatcher answers every command inline (plugins/dispatcher/src/
// commands.rs — the names there must match this list); global commands take
// up to an hour to propagate to all guilds.
//
// This is the canonical command set. The proxy mirrors it in
// server/src/discord.rs (`COMMAND_SET`) to auto-register the same commands
// on guild-registered custom apps — change both together.

const [, , applicationId] = process.argv;
const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  console.error("Missing DISCORD_BOT_TOKEN env var.");
  process.exit(1);
}
if (!applicationId) {
  console.error("Missing applicationId arg. Usage: node scripts/register-commands.mjs <applicationId>");
  process.exit(1);
}

const CHAT_INPUT = 1;
const USER = 2; // right-click a user → Apps
const MESSAGE = 3; // right-click a message → Apps
const GUILD_INSTALL = 0; // integration_types
const GUILD_CONTEXT = 0; // contexts: usable in servers only
const MANAGE_GUILD = "32"; // default_member_permissions

const commands = [
  {
    name: "dashboard",
    description: "Get the link to the DWEEB dashboard.",
    type: CHAT_INPUT,
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
  },
  // Context-menu commands take no description (Discord rejects one).
  {
    // Ephemeral share link that opens the editor pre-loaded with the
    // message — the resolved payload is re-encoded into the #s= token.
    name: "Edit in DWEEB",
    type: MESSAGE,
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
  },
  {
    // The message's postable wire JSON, in an ephemeral code block.
    name: "Export JSON",
    type: MESSAGE,
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
  },
  {
    // Toggles one of the guild's TTL-exemption slots on the message.
    // Visible to Manage Server holders by default; the dispatcher
    // re-checks the permission server-side either way.
    name: "Make Permanent",
    type: MESSAGE,
    default_member_permissions: MANAGE_GUILD,
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
  },
  {
    // Editor link with the webhook username/avatar prefilled from the
    // targeted member (nickname + guild avatar first).
    name: "Use as Webhook Identity",
    type: USER,
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "DWEEB (local-script, 0.1)",
  },
  body: JSON.stringify(commands),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Discord API error ${res.status}: ${body}`);
  process.exit(1);
}

const kind = { 1: "slash", 2: "user menu", 3: "message menu" };
for (const cmd of JSON.parse(body)) {
  console.log(`registered ${kind[cmd.type] ?? cmd.type}: ${cmd.name} (id ${cmd.id})`);
}
