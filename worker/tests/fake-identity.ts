import type { IdentityBinding, IdentityUser } from '../src/identity';

/**
 * A stand-in for the `IDENTITY` binding: `listUsers()` answers `users` (identity keeps the CID as
 * text), `setAttributes()` writes `discordId` onto the user and is recorded in `writes`. Fails every
 * call while `down` is true.
 */
export function fakeIdentity(users: IdentityUser[] = []): IdentityBinding & { users: IdentityUser[]; writes: { cid: string; attributes: object }[]; listCalls: number; down: boolean } {
  const identity = {
    users,
    writes: [] as { cid: string; attributes: object }[],
    listCalls: 0,
    down: false,
    async listUsers() {
      identity.listCalls += 1;
      if (identity.down) throw new Error('identity is down');
      return identity.users;
    },
    async setAttributes(cid: string, attributes: { discordId: string | null }) {
      if (identity.down) throw new Error('identity is down');
      identity.writes.push({ cid, attributes });
      const user = identity.users.find((candidate) => String(candidate.cid) === cid);
      if (user) user.discordId = attributes.discordId;
    },
  };
  return identity;
}

/** An identity user with made-up details; `discordId` is the account they linked, if any. */
export const idUser = (cid: number, discordId: string | null = null): IdentityUser => ({ cid: String(cid), discordId });
