import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ChannelEdit, ChannelIdSend, ChannelSend, MessageRef, ChannelsSync, DeleteRequest, DirectSend, GroupPost, LarryRpc, MemberRole, RolesSync } from './client/api';
import { deleteChannels, prepareChannelIdSend, syncChannels } from './managed-channels';
import { handleFetch, type BotEventsEnv } from './bot-events';
import { postToGroup } from './group-rpc';
import { getGroupStatus } from './groups';
import { consumeRoleSync, getLinks, linkDiscord, startRoleSync, syncMembers, unlink, type RoleSyncEnv, type RoleSyncMessage } from './role-sync';
import { deleteRoles, prepareMemberRole, setMemberRole, syncRoles } from './roles';
import { consume, deleteNow, editNow, enqueue, enqueueDelete, enqueueEdit, sendJob, sendNow, type QueueJob, type SendEnv } from './send';

type Env = SendEnv & RoleSyncEnv & BotEventsEnv;

/**
 * Larry's Worker. Other Workers reach these methods over a service binding. The fetch handler is
 * only for the bots on the VPS (bot-events.ts). The cron runs the role sync (role-sync.ts).
 */
export default class Larry extends WorkerEntrypoint<Env> implements LarryRpc {
  send(request: ChannelSend) {
    return sendNow(this.env, 'channel', request);
  }

  sendDirect(request: DirectSend) {
    return sendNow(this.env, 'direct', request);
  }

  enqueue(request: ChannelSend) {
    return enqueue(this.env, 'channel', request);
  }

  enqueueDirect(request: DirectSend) {
    return enqueue(this.env, 'direct', request);
  }

  editMessage(request: ChannelEdit) {
    return editNow(this.env, request);
  }

  enqueueEdit(request: ChannelEdit) {
    return enqueueEdit(this.env, request);
  }

  deleteMessage(request: MessageRef) {
    return deleteNow(this.env, request);
  }

  enqueueDelete(request: MessageRef) {
    return enqueueDelete(this.env, request);
  }

  syncRoles(request: RolesSync) {
    return syncRoles(this.env, request);
  }

  syncChannels(request: ChannelsSync) {
    return syncChannels(this.env, request);
  }

  setMemberRole(request: MemberRole) {
    return setMemberRole(this.env, request);
  }

  async enqueueMemberRole(request: MemberRole) {
    await this.env.LARRY_QUEUE.send(await prepareMemberRole(this.env, request));
  }

  deleteRoles(request: DeleteRequest) {
    return deleteRoles(this.env, request);
  }

  deleteChannels(request: DeleteRequest) {
    return deleteChannels(this.env, request);
  }

  async sendToChannel(request: ChannelIdSend) {
    return sendJob(this.env, await prepareChannelIdSend(this.env, request));
  }

  async enqueueToChannel(request: ChannelIdSend) {
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
  }

  linkDiscord(cid: number, discordId: string) {
    return linkDiscord(this.env, cid, discordId);
  }

  unlink(cid: number, service: 'discord' | 'teamspeak') {
    return unlink(this.env, cid, service);
  }

  getLinks(cid: number) {
    return getLinks(this.env, cid);
  }

  syncMembers(cids: number[]) {
    return syncMembers(this.env, cids);
  }

  postToGroup(request: GroupPost) {
    return postToGroup(this.env, request);
  }

  getGroupStatus(source: string) {
    return getGroupStatus(this.env, source);
  }

  /** Both queues come here: `role-sync` to the role sync, `larry-messages` to the sender. */
  queue(batch: MessageBatch<QueueJob> | MessageBatch<RoleSyncMessage>) {
    if (batch.queue === 'role-sync') return consumeRoleSync(batch as MessageBatch<RoleSyncMessage>, this.env);
    return consume(batch as MessageBatch<QueueJob>, this.env);
  }

  /** The bots' routes: `POST /bot/events` from larry's bot. */
  fetch(request: Request) {
    return handleFetch(request, this.env);
  }

  scheduled(_controller: ScheduledController) {
    return startRoleSync(this.env);
  }
}
