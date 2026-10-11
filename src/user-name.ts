import type { LocalUser } from '../shared/evaluation';

// Released migrations used Japanese built-in names. Localize their display only;
// keep stored names, attribution, and migration history intact.
export function displayUserName(user: LocalUser | undefined): string {
  if (!user) return 'Unknown creator';
  if (user.kind === 'legacy') return 'Legacy · unknown creator';
  return user.name === '\u81ea\u5206' ? 'Me' : user.name;
}
