import type { AppGroup } from 'asyar-sdk/contracts';

export function shouldConfirm(group: Pick<AppGroup, 'protected'>, skipConfirmation: boolean): boolean {
  return group.protected || !skipConfirmation;
}
