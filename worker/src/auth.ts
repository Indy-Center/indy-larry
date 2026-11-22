/**
 * The bots' shared secrets. The bots on the VPS reach the Worker over HTTPS, each with its own
 * secret, rather than holding a Cloudflare token: Cloudflare can't limit a token to one queue, and a
 * bot's secret can only do that bot's job. Each sends its secret as `Authorization: Bearer <secret>`;
 * each route checks it against that bot's secret only.
 */

/**
 * Whether the request carries `Authorization: Bearer <secret>`. Compared in constant time: both
 * sides are hashed first, so neither the secret's length nor where a guess goes wrong shows in the
 * timing. A secret the Worker doesn't have (unset or empty) lets nobody in.
 */
export async function hasBearer(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get('Authorization') ?? '';
  const sent = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const [a, b] = await Promise.all([sha256(sent), sha256(secret)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0 && sent !== '';
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
