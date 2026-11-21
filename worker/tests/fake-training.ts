import type { TrainingBinding, TrainingRoster } from '../src/training';

/** A stand-in for the `TRAINING` binding: answers `getRoster()` with `roster`, or fails when it is null. */
export function fakeTraining(roster: TrainingRoster | null): TrainingBinding & { calls: number } {
  const training = {
    calls: 0,
    async getRoster() {
      training.calls += 1;
      if (!roster) throw new Error('training-tools is down');
      return roster;
    },
  };
  return training;
}

/** A roster member shaped as training-tools sends them, with made-up names. */
export const trainee = (cid: number, certification: string | null = null, endorsements: string[] = []) => ({ cid: String(cid), certification, endorsements });
