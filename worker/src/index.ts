import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ChannelSend, DirectSend, LarryRpc } from './client/api';
import { consume, enqueue, sendNow, type Job, type SendEnv } from './send';

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

  queue(batch: MessageBatch<Job>) {
    return consume(batch, this.env);
  }
}
