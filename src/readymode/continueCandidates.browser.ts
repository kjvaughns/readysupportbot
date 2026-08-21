/// <reference lib="dom" />
/**
 * Browser-side enumeration of every control whose label is exactly "Continue".
 *
 * Serialized into the page, so it must stay self-contained. It returns
 * structural metadata only — tag, type, id, name, role, size, disabled,
 * visible — plus the label it matched on, which is the literal word "Continue".
 * No page content, no field values, no cookies, no personal data.
 */

export interface ContinueCandidateMetadata {
  tag: string;
  type: string | null;
  id: string | null;
  name: string | null;
  role: string | null;
  /** Always "Continue": that is what it matched on. */
  text: string;
  disabled: boolean;
  width: number;
  height: number;
  visible: boolean;
  /** Path only. A query string can carry a token, so it is dropped. */
  framePath: string;
  /** Position among all candidates in this frame, for building an exact locator. */
  indexInFrame: number;
}

export function collectContinueCandidates(): ContinueCandidateMetadata[] {
  const found: ContinueCandidateMetadata[] = [];

  const elements = Array.from(
    document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]'),
  );

  elements.forEach((element, index) => {
    const label = [
      element.textContent,
      element.getAttribute('value'),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!/^continue$/i.test(label)) return;

    const rect = (element as HTMLElement).getBoundingClientRect();
    const style = window.getComputedStyle(element);

    let framePath = '';
    try {
      framePath = new URL(location.href).pathname;
    } catch {
      framePath = '';
    }

    found.push({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type'),
      id: element.getAttribute('id') || null,
      name: element.getAttribute('name'),
      role: element.getAttribute('role'),
      text: 'Continue',
      disabled: (element as HTMLButtonElement).disabled === true,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0',
      framePath,
      indexInFrame: index,
    });
  });

  return found;
}
