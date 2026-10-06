import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ChannelSend, DirectSend, LarryRpc, RoomSend, RoomsSync } from './client/api';
import { prepareRoomSend, syncRooms } from './rooms';
import { consume, enqueue, sendJob, sendNow, type Job, type SendEnv } from './send';

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

  syncRooms(request: RoomsSync) {
    return syncRooms(this.env, request);
  }

  async sendRoom(request: RoomSend) {
    return sendJob(this.env, await prepareRoomSend(this.env, request));
  }

  async enqueueRoom(request: RoomSend) {
    await this.env.LARRY_QUEUE.send(await prepareRoomSend(this.env, request));
  }

  queue(batch: MessageBatch<Job>) {
    return consume(batch, this.env);
  }
}
