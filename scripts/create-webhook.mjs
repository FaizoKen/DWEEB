// Provisions a bot-owned webhook in a channel and prints the webhook URL.
//
// Usage (PowerShell):
//   $env:DISCORD_BOT_TOKEN = "your-bot-token"
//   node scripts/create-webhook.mjs <channelId> [webhookName]
//
// The bot must be in the guild and have the MANAGE_WEBHOOKS permission on the target channel.

const [, , channelId, nameArg] = process.argv;
const token = process.env.DISCORD_BOT_TOKEN;
const name = nameArg ?? "DWEEB Test";

if (!token) {
  console.error("Missing DISCORD_BOT_TOKEN env var.");
  process.exit(1);
}
if (!channelId) {
  console.error("Missing channelId arg. Usage: node scripts/create-webhook.mjs <channelId> [name]");
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
  method: "POST",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "DiscordWebhookBuilder (local-script, 0.1)",
  },
  body: JSON.stringify({ name }),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Discord API error ${res.status}: ${body}`);
  process.exit(1);
}

const hook = JSON.parse(body);
const url = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
console.log(url);
