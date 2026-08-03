import { getNextBuilderEager } from './builder-eager.js';

export async function getNextBuilder(_nextVersion: string) {
  return getNextBuilderEager();
}
