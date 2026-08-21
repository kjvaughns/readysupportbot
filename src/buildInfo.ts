/* eslint-disable no-console -- Deliberate, temporary deployment diagnostics.
 *
 * These go to stdout rather than through the structured logger so they are
 * visible in a platform's raw log tail with no log level and no JSON viewer.
 * They exist to settle one question — is the deployed build running the current
 * authentication code — and none of them prints a credential, a cookie, a
 * token, a name, or any page content. Remove them once the deployment is
 * confirmed and `AUTH_FLOW_VERSION` has served its purpose.
 */
/**
 * What is actually running.
 *
 * A fix that is committed, pushed and passing tests still changes nothing until
 * the platform runs it — and from the outside, "the deploy did not happen" and
 * "the fix does not work" look identical. This makes the difference readable:
 * every health check and every discovery response carries the version of the
 * authentication flow and the commit the container was built from.
 *
 * Bump `AUTH_FLOW_VERSION` whenever the authentication path changes in a way
 * somebody might need to confirm from the outside.
 */

export const AUTH_FLOW_VERSION = 'readymode_continue_v1';

/**
 * The commit this container was built from.
 *
 * Railway injects `RAILWAY_GIT_COMMIT_SHA`. The others are checked so the same
 * field is useful under a different platform, and `unknown` is reported plainly
 * rather than guessed at.
 */
export function commitSha(): string {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.SOURCE_COMMIT ??
    process.env.GIT_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    'unknown'
  );
}

export interface BuildInfo {
  authFlowVersion: string;
  commitSha: string;
  /** Short form, for reading against `git log --oneline`. */
  commitShort: string;
  startedAt: string;
}

const startedAt = new Date().toISOString();

export function buildInfo(): BuildInfo {
  const sha = commitSha();
  return {
    authFlowVersion: AUTH_FLOW_VERSION,
    commitSha: sha,
    commitShort: sha === 'unknown' ? 'unknown' : sha.slice(0, 7),
    startedAt,
  };
}

/**
 * Printed once at startup, on stdout.
 *
 * Deliberately `console.log` rather than the structured logger: it has to be
 * visible in a platform's log tail without a log level or a JSON viewer.
 */
export function announceBuild(): void {
  const info = buildInfo();
  console.log(
    `[ReadySupport] authFlowVersion=${info.authFlowVersion} commit=${info.commitShort} startedAt=${info.startedAt}`,
  );
}
