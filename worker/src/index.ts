import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ChannelEdit, ChannelIdSend, ChannelSend, MessageRef, ChannelsSync, DeleteRequest, DirectSend, GroupPost, LarryRpc, MemberRole, RolesSync } from './client/api';
import { describeError, ErrorReport } from './errors';
import { deleteChannels, prepareChannelIdSend, syncChannels } from './managed-channels';
import { handleFetch, type BotEventsEnv } from './bot-events';
import { postToGroup } from './group-rpc';
import { getGroupStatus } from './groups';
import { linkDiscord } from './platforms/discord';
import { consumeRoleSync, getLinks, startRoleSync, syncMembers, unlink, type RoleSyncEnv, type RoleSyncMessage } from './role-sync';
import { deleteRoles, prepareMemberRole, setMemberRole, syncRoles } from './roles';
import { consume, deleteNow, editNow, enqueue, enqueueDelete, enqueueEdit, sendJob, sendNow, SetupFaultError, type QueueJob, type SendEnv } from './send';

/**
 * Run one call, report what it throws (a refused request included: the caller may not check) to ERROR_CHANNEL_ID,
 * and throw it on unchanged. The report goes out after the call returns (errors.ts). A plain function, not a method,
 * so callers can't reach it over RPC.
 */
async function reported<T>(env: SendEnv, ctx: ExecutionContext, method: string, run: (report: ErrorReport) => T | Promise<T>): Promise<T> {
  const report = new ErrorReport(env);
  try {
    return await run(report);
  } catch (error) {
    if (!(error instanceof SetupFaultError)) report.add(`${method} failed: ${describeError(error)}`);
    throw error;
  } finally {
    // Without waitUntil (a test's stand-in context), the report still goes out, just not held open for.
    const sending = report.flush();
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(sending);
  }
}

type Env = SendEnv & RoleSyncEnv & BotEventsEnv;

/**
 * Larry's Worker. Other Workers reach these methods over a service binding. The fetch handler is
 * only for the bots on the VPS (bot-events.ts). The cron runs the role sync (role-sync.ts).
 */
export default class Larry extends WorkerEntrypoint<Env> implements LarryRpc {
  send(request: ChannelSend) {
    return reported(this.env, this.ctx, 'send()', () => sendNow(this.env, 'channel', request));
  }

  sendDirect(request: DirectSend) {
    return reported(this.env, this.ctx, 'sendDirect()', () => sendNow(this.env, 'direct', request));
  }

  enqueue(request: ChannelSend) {
    return reported(this.env, this.ctx, 'enqueue()', () => enqueue(this.env, 'channel', request));
  }

  enqueueDirect(request: DirectSend) {
    return reported(this.env, this.ctx, 'enqueueDirect()', () => enqueue(this.env, 'direct', request));
  }

  editMessage(request: ChannelEdit) {
    return reported(this.env, this.ctx, 'editMessage()', () => editNow(this.env, request));
  }

  enqueueEdit(request: ChannelEdit) {
    return reported(this.env, this.ctx, 'enqueueEdit()', () => enqueueEdit(this.env, request));
  }

  deleteMessage(request: MessageRef) {
    return reported(this.env, this.ctx, 'deleteMessage()', () => deleteNow(this.env, request));
  }

  enqueueDelete(request: MessageRef) {
    return reported(this.env, this.ctx, 'enqueueDelete()', () => enqueueDelete(this.env, request));
  }

  syncRoles(request: RolesSync) {
    return reported(this.env, this.ctx, 'syncRoles()', () => syncRoles(this.env, request));
  }

  syncChannels(request: ChannelsSync) {
    return reported(this.env, this.ctx, 'syncChannels()', () => syncChannels(this.env, request));
  }

  setMemberRole(request: MemberRole) {
    return reported(this.env, this.ctx, 'setMemberRole()', () => setMemberRole(this.env, request));
  }

  enqueueMemberRole(request: MemberRole) {
    return reported(this.env, this.ctx, 'enqueueMemberRole()', async () => {
      await this.env.LARRY_QUEUE.send(await prepareMemberRole(this.env, request));
    });
  }

  deleteRoles(request: DeleteRequest) {
    return reported(this.env, this.ctx, 'deleteRoles()', () => deleteRoles(this.env, request));
  }

  deleteChannels(request: DeleteRequest) {
    return reported(this.env, this.ctx, 'deleteChannels()', () => deleteChannels(this.env, request));
  }

  sendToChannel(request: ChannelIdSend) {
    return reported(this.env, this.ctx, 'sendToChannel()', async () => sendJob(this.env, await prepareChannelIdSend(this.env, request)));
  }

  enqueueToChannel(request: ChannelIdSend) {
    return reported(this.env, this.ctx, 'enqueueToChannel()', async () => {
      // DEBUG (hung enqueueToChannel): remove once the hang is found.
      const started = Date.now();
      const step = (what: string) => console.log(`[debug enqueueToChannel ${request?.channelId}] ${what} +${Date.now() - started}ms`);
      step('called');
      try {
        const job = await prepareChannelIdSend(this.env, request);
        step('channel checked; writing to the queue');
        await this.env.LARRY_QUEUE.send(job);
        step('queued');
      } catch (error) {
        step(`refusing the call with: ${String(error)}`);
        throw error;
      }
    });
  }

  linkDiscord(cid: number, discordId: string, accessToken?: string) {
    return reported(this.env, this.ctx, 'linkDiscord()', () => linkDiscord(this.env, cid, discordId, accessToken));
  }

  unlink(cid: number, service: 'discord' | 'teamspeak') {
    return reported(this.env, this.ctx, 'unlink()', () => unlink(this.env, cid, service));
  }

  getLinks(cid: number) {
    return reported(this.env, this.ctx, 'getLinks()', () => getLinks(this.env, cid));
  }

  syncMembers(cids: number[]) {
    return reported(this.env, this.ctx, 'syncMembers()', () => syncMembers(this.env, cids));
  }

  postToGroup(request: GroupPost) {
    return reported(this.env, this.ctx, 'postToGroup()', () => postToGroup(this.env, request));
  }

  getGroupStatus(source: string) {
    return reported(this.env, this.ctx, 'getGroupStatus()', () => getGroupStatus(this.env, source));
  }

  /** Both queues come here: `role-sync` to the role sync, `larry-messages` to the sender. */
  queue(batch: MessageBatch<QueueJob> | MessageBatch<RoleSyncMessage>) {
    if (batch.queue === 'role-sync') {
      return reported(this.env, this.ctx, 'Role sync queue consumer', () => consumeRoleSync(batch as MessageBatch<RoleSyncMessage>, this.env));
    }
    return reported(this.env, this.ctx, 'Queue consumer', (report) => consume(batch as MessageBatch<QueueJob>, this.env, (text) => report.add(text)));
  }

  /** The bots' routes: `POST /bot/events` from larry's bot. */
  fetch(request: Request) {
    return reported(this.env, this.ctx, 'Bot events route', () => handleFetch(request, this.env));
  }

  scheduled(_controller: ScheduledController) {
    return reported(this.env, this.ctx, 'Role sync cron', () => startRoleSync(this.env));
  }
}
