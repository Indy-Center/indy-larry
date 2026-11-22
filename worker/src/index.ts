import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ChannelEdit, ChannelIdSend, ChannelSend, MessageRef, ChannelsSync, DeleteRequest, DirectSend, LarryRpc, MemberRole, RolesSync } from './client/api';
import { describeError, ErrorReport } from './errors';
import { deleteChannels, prepareChannelIdSend, syncChannels } from './managed-channels';
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
    ctx.waitUntil(report.flush());
  }
}

/** Larry's send Worker. Other Workers reach these methods over a service binding; there's no fetch handler. */
export default class Larry extends WorkerEntrypoint<SendEnv> implements LarryRpc {
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

  queue(batch: MessageBatch<QueueJob>) {
    return reported(this.env, this.ctx, 'Queue consumer', (report) => consume(batch, this.env, (text) => report.add(text)));
  }
}
