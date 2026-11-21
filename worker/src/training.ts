/**
 * The training app's roster, the role sync's source for certifications and endorsements (they map to
 * Discord roles only). `TRAINING` is a service binding to `training-tools`' `TrainingRpc` entrypoint.
 */

/**
 * The part of `TrainingRpc.getRoster()`'s answer the sync reads, as `@indy-center/training-tools` types it
 * (training-tools' `rpc/src/index.ts`). Kept here, not imported, so the Worker takes no dependency for it.
 */
export type TrainingRoster = {
  members: { cid: string; certification: string | null; endorsements: string[] }[];
};

export type TrainingBinding = { getRoster(): Promise<TrainingRoster> };

/** The credential codes each CID holds: their highest certification and every endorsement. */
export type Credentials = Record<string, string[]>;

/**
 * Read the roster once. Returns null when the call fails or the roster comes back empty: an empty roster
 * would read as everyone losing their certification roles.
 */
export async function fetchCredentials(training: TrainingBinding): Promise<Credentials | null> {
  try {
    const { members } = await training.getRoster();
    if (!Array.isArray(members) || members.length === 0) throw new Error('empty');
    return Object.fromEntries(members.map((member) => [member.cid, [...(member.certification ? [member.certification] : []), ...(member.endorsements ?? [])]]));
  } catch (error) {
    console.warn(`The training roster failed: ${String(error)}`);
    return null;
  }
}
