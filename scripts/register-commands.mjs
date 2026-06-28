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
// This is the canonical command set (the MAIN app's). The proxy mirrors it in
// server/src/discord.rs (`command_set()`) to auto-register the same commands
// on guild-registered custom apps — change both together, EXCEPT that custom
// apps keep `/dashboard` guild-only: user-install needs each app's own portal
// opt-in, and a rejected registration would drop all their commands.

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
const GUILD_INSTALL = 0; // integration_types: installed to a server
const USER_INSTALL = 1; // integration_types: installed to a user account
const GUILD_CONTEXT = 0; // contexts: in a server
const BOT_DM = 1; // contexts: the bot's own DM
const PRIVATE_CHANNEL = 2; // contexts: any DM / group DM (needs USER_INSTALL)

const commands = [
  {
    // `/dashboard` is a pure informational reply (just the dashboard URL), so
    // it's exposed everywhere: installed to servers AND user accounts, and
    // usable in servers, the bot's DM, and any DM / group DM. The USER_INSTALL
    // integration and the PRIVATE_CHANNEL context require "User Install" to be
    // enabled in the app's Developer Portal (Installation → Installation
    // Contexts) — Discord rejects the registration otherwise.
    name: "dashboard",
    description: "Get the link to the DWEEB dashboard.",
    type: CHAT_INPUT,
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: [GUILD_CONTEXT, BOT_DM, PRIVATE_CHANNEL],
  },
  // The context-menu commands stay server-only (GUILD_INSTALL / GUILD_CONTEXT):
  // they act on guild messages/members, and "Message Info"'s never-expire slot
  // store is keyed to guilds DWEEB manages — exposing them in DMs or in servers
  // where the app isn't installed only invites confusing dead-ends.
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
    // Ephemeral rundown of the message — author, timestamps, ids, and its
    // component-expiry status — plus a permanent-slot toggle button for
    // Manage Server holders (the permission is re-checked on click).
    name: "Message Info",
    type: MESSAGE,
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

const url = `https://discord.com/api/v10/applications/${applicationId}/commands`;
const headers = {
  Authorization: `Bot ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "DWEEB (local-script, 0.1)",
};

// An app with a Discord Activity has an auto-created "Launch" Entry Point
// command (type 4). A bulk PUT that omits it is rejected (error 50240), so
// fetch the current set and carry any Entry Point command through unchanged —
// passing it back with its id preserves it. Apps without an Activity (e.g.
// the dev app) just return none here, so this is a no-op for them.
const PRIMARY_ENTRY_POINT = 4;
const existingRes = await fetch(url, { headers });
if (!existingRes.ok) {
  console.error(`Discord API error ${existingRes.status} (listing commands): ${await existingRes.text()}`);
  process.exit(1);
}
const entryPoints = (await existingRes.json()).filter((c) => c.type === PRIMARY_ENTRY_POINT);

const res = await fetch(url, {
  method: "PUT",
  headers,
  body: JSON.stringify([...commands, ...entryPoints]),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Discord API error ${res.status}: ${body}`);
  process.exit(1);
}

const kind = { 1: "slash", 2: "user menu", 3: "message menu", 4: "entry point" };
for (const cmd of JSON.parse(body)) {
  console.log(`registered ${kind[cmd.type] ?? cmd.type}: ${cmd.name} (id ${cmd.id})`);
}
