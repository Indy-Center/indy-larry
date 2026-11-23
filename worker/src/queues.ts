/** What every queue consumer and producer of the role sync and TeamSpeak's results share. */

/** Queues takes at most 100 messages in one sendBatch. */
const SEND_BATCH = 100;

/** Send every body, in as few batches as Queues allows. */
export async function sendInBatches<Body>(queue: Queue<Body>, bodies: Body[]): Promise<void> {
  for (let i = 0; i < bodies.length; i += SEND_BATCH) await queue.sendBatch(bodies.slice(i, i + SEND_BATCH).map((body) => ({ body })));
}

/**
 * Hand each message of a batch to `handle`, acking it when that returns and retrying it alone (backing off
 * 10 seconds per attempt) when it throws. `what` names the message in the log line.
 */
export async function consumeEach<Body>(batch: MessageBatch<Body>, what: string, handle: (body: Body) => Promise<void>): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handle(message.body);
      message.ack();
    } catch (error) {
      console.error(`${what} failed, retrying: ${String(error)}`);
      message.retry({ delaySeconds: 10 * message.attempts });
    }
  }
}
