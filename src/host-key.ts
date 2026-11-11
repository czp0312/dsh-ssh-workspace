/** Host-key classification shared by the host process and the browser client.
 *
 * Keep this module free of Node.js APIs: the DSH client bundle imports it too.
 */

export type HostKeyFailure = 'unknown' | 'changed'

/** An OpenSSH SHA256 fingerprint: `SHA256:` + unpadded base64 of the hashed key blob. */
export const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/

export function isHostKeyFingerprint(value: unknown): value is string {
  return typeof value === 'string' && HOST_KEY_FINGERPRINT.test(value)
}

/** Classify an OpenSSH host-key failure from a transport error message.
 *
 * A changed key also ends with "Host key verification failed", so it wins.
 * Only host-key trust failures match; unrelated algorithm or key-file errors do not.
 */
export function classifyHostKeyFailure(message: unknown): HostKeyFailure | undefined {
  if (typeof message !== 'string' || !message) return undefined
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed|POSSIBLE DNS SPOOFING|man-in-the-middle/i.test(message)) return 'changed'
  if (/No \S+ host key is known for \S+ and you have requested strict checking|Host key verification failed/i.test(message)) return 'unknown'
  return undefined
}
