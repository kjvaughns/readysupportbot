/**
 * Encoding for interaction component ids.
 *
 * Discord allows 100 characters. The format is:
 *
 *   rs:<kind>:<requestId>:<nonce>
 *
 * The nonce is the important part. It is generated when the approval is opened
 * and stored on the approval row, and a click carrying a nonce that does not
 * match the open approval is rejected. That makes a button single-use and
 * bound to one specific approval: an old message cannot approve a new request,
 * and a hand-crafted custom id cannot approve anything.
 */

export const CUSTOM_ID_PREFIX = 'rs';

export type ComponentKind =
  | 'approve'
  | 'cancel'
  | 'pick_account'
  | 'provide_info'
  | 'info_modal'
  | 'override_call'
  | 'reconnect_done';

export interface ComponentId {
  kind: ComponentKind;
  requestId: string;
  nonce: string;
}

export function encodeComponentId(id: ComponentId): string {
  const encoded = [CUSTOM_ID_PREFIX, id.kind, id.requestId, id.nonce].join(':');
  if (encoded.length > 100) {
    throw new Error(`Component id is too long for Discord (${encoded.length} characters)`);
  }
  return encoded;
}

/** Returns undefined for anything that is not one of ours. */
export function decodeComponentId(raw: string): ComponentId | undefined {
  const parts = raw.split(':');
  if (parts.length !== 4) return undefined;

  const [prefix, kind, requestId, nonce] = parts;
  if (prefix !== CUSTOM_ID_PREFIX) return undefined;
  if (!kind || !requestId || !nonce) return undefined;

  if (!isComponentKind(kind)) return undefined;

  return { kind, requestId, nonce };
}

function isComponentKind(value: string): value is ComponentKind {
  return [
    'approve',
    'cancel',
    'pick_account',
    'provide_info',
    'info_modal',
    'override_call',
    'reconnect_done',
  ].includes(value);
}
