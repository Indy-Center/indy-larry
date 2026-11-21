import type { Group, GroupSource, GroupsAnswer } from '../src/client/api';

/**
 * A stand-in for a group source's binding (`TRAINING`): answers `getGroups()` with `answer`, which a test
 * may change between calls, or throws while `down`.
 */
export function fakeSource(groups: Group[] = []): GroupSource & { answer: GroupsAnswer; down: boolean; calls: number } {
  const source = {
    answer: { groups } as GroupsAnswer,
    down: false,
    calls: 0,
    async getGroups() {
      source.calls += 1;
      if (source.down) throw new Error('training-tools is down');
      return structuredClone(source.answer);
    },
  };
  return source;
}

/** A group with made-up members. */
export const group = (key: string, name: string, members: number[], extra: Partial<Group> = {}): Group => ({ key, name, members: members.map(String), ...extra });
