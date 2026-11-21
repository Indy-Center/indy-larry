/**
 * Identity's user records, the role sync's source for Discord links. The only file that talks to the
 * `IDENTITY` service binding, so a later swap to a lookup method or a typed field is a change here.
 */

/** The part of a user record the sync reads. Identity keeps the CID as text. */
export type IdentityUser = { cid: string | number; discordId?: string | null };

/** The `IDENTITY` binding's RPC methods the sync calls. */
export type IdentityBinding = {
  listUsers(): Promise<IdentityUser[]>;
  setAttributes(cid: string, attributes: { discordId: string | null }): Promise<unknown>;
};

/** Everyone identity knows: their CID, and the Discord account they linked (null for none). */
export type Member = { cid: number; discordId: string | null };

/** Identity's whole member list in one call. Throws if the call fails. */
export async function listIdentityMembers(identity: IdentityBinding): Promise<Member[]> {
  const users = await identity.listUsers();
  return users.map((user) => ({ cid: Number(user.cid), discordId: user.discordId || null }));
}

/** The Discord accounts linked in identity, as the sync keeps them for a run. */
export const linksOf = (members: Member[]): { cid: number; discordId: string }[] =>
  members.flatMap((member) => (member.discordId ? [{ cid: member.cid, discordId: member.discordId }] : []));

/** Link a Discord account to a CID, or (null) clear the link. */
export async function writeDiscordId(identity: IdentityBinding, cid: number, discordId: string | null): Promise<void> {
  await identity.setAttributes(String(cid), { discordId });
}
