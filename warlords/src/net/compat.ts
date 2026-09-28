// The game-compatibility id of this build (scripts/compat-id.mjs via the vite configs'
// define): a hash of everything the match and the wire depend on. A server-run room
// runs the server's build — a page of another build is refused (POST /api/rooms 409,
// hello → versionMismatch) instead of desyncing silently.
// null: a build without the id (another bundler) — nothing is claimed, nothing is refused.
declare const __SGWL_COMPAT__: string | undefined;

export const COMPAT_ID: string | null = typeof __SGWL_COMPAT__ === 'string' && __SGWL_COMPAT__ ? __SGWL_COMPAT__ : null;
