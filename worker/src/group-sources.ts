import type { GroupSource } from './client/api';
import { SNOWFLAKE } from './discord';

/**
 * The group sources: apps that serve groups through `getGroups()` (client/api.ts), each over a service
 * binding in wrangler.jsonc. larry makes a Discord role for each group they serve, and a channel for a
 * group with a room (groups.ts). Like mapping.ts, typed so the build catches a bad entry; change it by
 * pull request.
 *
 * Adding a source: a service binding in wrangler.jsonc, its name in `SourceBinding` and on
 * `GroupSourcesEnv`, a mode setting on `GroupSourcesEnv` (and in the deploy), and an entry here.
 */

/** The service bindings a source can be read through. */
export type SourceBinding = 'TRAINING';

/** The settings that hold a source's mode: `off` (or unset, or anything else), `dry-run` or `live`. */
export type ModeSetting = 'GROUP_SYNC_TRAINING';

export type GroupSourcesEnv = { [B in SourceBinding]: GroupSource } & { [M in ModeSetting]?: string };

export type GroupSourceConfig = {
  /** The source's name: in KV keys, logs, alerts, postToGroup() and getGroupStatus(). */
  source: string;
  binding: SourceBinding;
  /** The CHANNEL_CATEGORIES name its rooms are made under. */
  roomCategory: string;
  /** Role IDs, besides the group's own, that see every one of its rooms (when larry creates the room). */
  roomViewers: string[];
  modeSetting: ModeSetting;
};

export const GROUP_SOURCES: GroupSourceConfig[] = [
  {
    // training-tools' TrainingRpc: one group per credential, and one per teacher with their students and a room.
    source: 'training',
    binding: 'TRAINING',
    roomCategory: 'training',
    // The training admins.
    roomViewers: ['1389685131744383138'],
    modeSetting: 'GROUP_SYNC_TRAINING',
  },
];

/** Throws on a config larry can't honour. Run by the tests, so a bad entry fails CI. */
export function checkGroupSources(sources: GroupSourceConfig[]): void {
  const names = new Set<string>();
  for (const config of sources) {
    if (!/^[a-z][a-z0-9-]*$/.test(config.source)) throw new Error(`Group source "${config.source}": use lowercase letters, digits and hyphens`);
    if (names.has(config.source)) throw new Error(`Group source "${config.source}" is listed twice`);
    names.add(config.source);
    for (const id of config.roomViewers) if (!SNOWFLAKE.test(id)) throw new Error(`Group source "${config.source}": room viewer "${id}" isn't a Discord role ID`);
  }
}

export type GroupMode = 'off' | 'dry-run' | 'live';

/** The source's mode, from its setting. Anything but `dry-run` or `live` is `off`. */
export function sourceMode(env: Partial<Record<ModeSetting, string>>, config: GroupSourceConfig): GroupMode {
  const value = env[config.modeSetting];
  return value === 'dry-run' || value === 'live' ? value : 'off';
}
