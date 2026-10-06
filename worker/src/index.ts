import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ChannelIdSend, ChannelSend, ChannelsSync, DeleteRequest, DirectSend, LarryRpc, MemberRole, RolesSync } from './client/api';
import { deleteChannels, prepareChannelIdSend, syncChannels } from './managed-channels';
import { deleteRoles, prepareMemberRole, setMemberRole, syncRoles } from './roles';
import { consume, enqueue, sendJob, sendNow, type QueueJob, type SendEnv } from './send';

/** Larry's send Worker. Other Workers reach these methods over a service binding; there's no fetch handler. */
export default class Larry extends WorkerEntrypoint<SendEnv> implements LarryRpc {
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
    await this.env.LARRY_QUEUE.send(await prepareChannelIdSend(this.env, request));
  }

  queue(batch: MessageBatch<QueueJob>) {
    return consume(batch, this.env);
  }
}
