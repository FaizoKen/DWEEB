// Registers the app's global slash commands (just /dashboard). Run once;
// PUT replaces the full set, so re-running is idempotent.
//
// Usage (PowerShell):
//   $env:DISCORD_BOT_TOKEN = "your-bot-token"
//   node scripts/register-commands.mjs <applicationId>
//
// The dispatcher answers /dashboard inline (plugins/dispatcher); global
// commands take up to an hour to propagate to all guilds.

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

const commands = [
  {
    name: "dashboard",
    description: "Get the link to the DWEEB dashboard.",
    type: 1, // CHAT_INPUT
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

for (const cmd of JSON.parse(body)) {
  console.log(`registered /${cmd.name} (id ${cmd.id})`);
}
