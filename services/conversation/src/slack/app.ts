/**
 * Boots the Slack Bolt app in Socket Mode and routes button clicks to SlackBot.handleDecision.
 * Socket Mode needs no public URL, which suits a laptop behind a tunnel.
 */
import bolt from "@slack/bolt";
import type { Logger } from "../logger.ts";
import { APPROVE_ACTION, DENY_ACTION } from "./blocks.ts";
import type { SlackBot } from "./bot.ts";

const { App, LogLevel } = bolt;

export type BoltApp = InstanceType<typeof App>;

export function createSlackApp(opts: { botToken: string; appToken: string; log: Logger }): BoltApp {
  return new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });
}

export function registerSlackHandlers(app: BoltApp, bot: SlackBot, log: Logger): void {
  for (const actionId of [APPROVE_ACTION, DENY_ACTION]) {
    app.action(actionId, async ({ ack, body, action, client }) => {
      await ack();
      const requestId = "value" in action && typeof action.value === "string" ? action.value : undefined;
      if (!requestId) return;
      const b = body as { user: { id: string; name?: string; username?: string }; channel?: { id: string }; message?: { ts: string } };
      const error = await bot.handleDecision({
        requestId,
        decision: actionId === APPROVE_ACTION ? "approve" : "deny",
        userId: b.user.id,
        userName: b.user.name ?? b.user.username,
        channel: b.channel?.id,
        messageTs: b.message?.ts,
      });
      if (error && b.channel?.id) {
        await client.chat.postEphemeral({ channel: b.channel.id, user: b.user.id, text: error }).catch((err: Error) => log.warn("slack: ephemeral failed", { error: err.message }));
      }
    });
  }
  app.error(async (err) => {
    log.error("slack: bolt error", { error: (err as Error).message });
  });
}
