/** What the Worker's HTTP routes share. */

/** An empty answer with this status. */
export const status = (code: number) => new Response(null, { status: code });

/** The request's body as JSON, or undefined when it isn't JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    return undefined;
  }
}
