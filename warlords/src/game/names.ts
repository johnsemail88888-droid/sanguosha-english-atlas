// Display names: the host names bot seats "人机N" (one name for every client);
// each client shows it in its own language ("Bot N" in English). Players who
// never typed a name are "无名N" everywhere ("Nameless N" in English).
import type { Lang } from './settings';

const BOT_NAME = /^人机\s*(\d+)$/;
/** the name the app generates for a player who never typed one (stored language-neutral as 无名N) */
const DEFAULT_NAME = /^无名\s*(\d+)$/;

/** Player name as shown to a viewer using `lang`. */
export function displayName(name: string, lang: Lang): string {
  if (lang === 'en') {
    const m = BOT_NAME.exec(name);
    if (m) return `Bot ${m[1]}`;
    const d = DEFAULT_NAME.exec(name);
    if (d) return `Nameless ${d[1]}`;
  }
  return name;
}
