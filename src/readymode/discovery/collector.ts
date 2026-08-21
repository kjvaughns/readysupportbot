/// <reference lib="dom" />
/**
 * The browser-side evidence collector.
 *
 * This function is serialized and executed inside the Readymode page, so it
 * must stay self-contained — it cannot reference anything from Node scope. It
 * is isolated in its own file so DOM types can be enabled here without letting
 * browser globals leak into the rest of the backend.
 *
 * It reads attributes, text and computed styles. It never calls click, fill,
 * submit or focus, and never reads `.value`, `.checked`, cookies or storage.
 */
import type { CollectorOptions, CollectorOutput } from './evidence';

/**
 * Takes ONE object argument, because `page.evaluate` serializes exactly one.
 * It previously took two positional parameters and was called with a single
 * object through an `as never` cast, so `stableAttributes` arrived undefined
 * and every root threw before collecting anything.
 */
export function collectFromRoot({ caps, stableAttributes }: CollectorOptions): CollectorOutput {
  const cap = <T>(list: T[], max: number): T[] => list.slice(0, max);
  const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

  const isVisible = (element: Element): boolean => {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = (element as HTMLElement).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const attrs = (element: Element): Record<string, string> => {
    const output: Record<string, string> = {};
    for (const attribute of stableAttributes) {
      const value = element.getAttribute(attribute);
      if (value) output[attribute] = value.slice(0, 200);
    }
    return output;
  };

  const cssPath = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    let depth = 0;
    while (current && depth < 6 && current.tagName.toLowerCase() !== 'html') {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      current = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const labelFor = (element: Element): string => {
    const id = element.getAttribute('id');
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return text(label.textContent);
    }
    const ancestor = element.closest('label');
    if (ancestor) return text(ancestor.textContent);
    return '';
  };

  const accessibleName = (element: Element): string =>
    text(
      element.getAttribute('aria-label') ??
        element.textContent ??
        element.getAttribute('title') ??
        element.getAttribute('alt') ??
        '',
    );

  const base = (element: Element, ordinal: number) => ({
    ordinal,
    tag: element.tagName.toLowerCase(),
    id: element.getAttribute('id') ?? undefined,
    name: element.getAttribute('name') ?? undefined,
    attrs: attrs(element),
    cssPath: cssPath(element),
    visible: isVisible(element),
  });

  const truncated: string[] = [];
  const note = (category: string, found: number, max: number) => {
    if (found > max) truncated.push(category);
  };

  // -- buttons ---------------------------------------------------------------
  const buttonNodes = Array.from(
    document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="reset"], [role="button"], a.btn, a.button'),
  );
  note('buttons', buttonNodes.length, caps.maxButtons);
  const buttons = cap(buttonNodes, caps.maxButtons).map((element, index) => {
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    return {
      ...base(element as Element, index + 1),
      kind: (type === 'submit'
        ? 'submit'
        : type === 'reset'
          ? 'reset'
          : (element as Element).tagName === 'A'
            ? 'link-button'
            : 'button') as CollectorOutput['buttons'][number]['kind'],
      // The button's own value attribute is its label, not user data.
      label: accessibleName(element as Element) || text((element as Element).getAttribute('value')),
      role: (element as Element).getAttribute('role') ?? undefined,
      disabled: (element as HTMLButtonElement).disabled === true,
    };
  });

  // -- inputs ----------------------------------------------------------------
  const inputNodes = Array.from(document.querySelectorAll('input, textarea'));
  note('inputs', inputNodes.length, caps.maxInputs);
  let passwordFieldsSeen = 0;
  const inputs = cap(inputNodes, caps.maxInputs).map((element, index) => {
    const type = ((element as HTMLInputElement).type ?? 'text').toLowerCase();
    const sensitive = type === 'password';
    if (sensitive) passwordFieldsSeen += 1;

    // Note what is absent: value, defaultValue, checked. Never read.
    const record: CollectorOutput['inputs'][number] = {
      ...base(element as Element, index + 1),
      type,
      required: (element as HTMLInputElement).required === true,
      readOnly: (element as HTMLInputElement).readOnly === true,
      sensitive,
      ariaLabel: (element as Element).getAttribute('aria-label') ?? undefined,
      labelText: labelFor(element as Element),
    };
    // A password field keeps only its structural identity.
    if (!sensitive) record.placeholder = (element as Element).getAttribute('placeholder') ?? undefined;
    return record;
  });

  // -- selects ---------------------------------------------------------------
  const selectNodes = Array.from(document.querySelectorAll('select'));
  note('selects', selectNodes.length, caps.maxSelects);
  const selects = cap(selectNodes, caps.maxSelects).map((element, index) => {
    const options = Array.from((element as HTMLSelectElement).options);
    return {
      ...base(element as Element, index + 1),
      multiple: (element as HTMLSelectElement).multiple === true,
      ariaLabel: (element as Element).getAttribute('aria-label') ?? undefined,
      labelText: labelFor(element as Element),
      optionCount: options.length,
      optionLabels: options.slice(0, caps.maxOptionsPerSelect).map((option) => text(option.textContent)),
      optionValues: options.slice(0, caps.maxOptionsPerSelect).map((option) => (option.getAttribute('value') ?? '').slice(0, 60)),
    };
  });

  // -- checkboxes ------------------------------------------------------------
  const checkboxNodes = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
  note('checkboxes', checkboxNodes.length, caps.maxCheckboxes);
  const checkboxes = cap(checkboxNodes, caps.maxCheckboxes).map((element, index) => ({
    // `checked` is deliberately absent: it is configuration data, read by the
    // workflows at run time, not something discovery needs to store.
    ...base(element as Element, index + 1),
    ariaLabel: (element as Element).getAttribute('aria-label') ?? undefined,
    labelText: labelFor(element as Element),
    nearbyText: text((element as Element).parentElement?.textContent).slice(0, caps.maxNearbyTextLength),
  }));

  // -- links -----------------------------------------------------------------
  const linkNodes = Array.from(document.querySelectorAll('a[href]'));
  note('links', linkNodes.length, caps.maxLinks);
  const links = cap(linkNodes, caps.maxLinks).map((element, index) => ({
    ...base(element as Element, index + 1),
    label: accessibleName(element as Element),
    href: ((element as HTMLAnchorElement).getAttribute('href') ?? '').slice(0, caps.maxUrlLength),
  }));

  // -- forms -----------------------------------------------------------------
  const formNodes = Array.from(document.querySelectorAll('form'));
  note('forms', formNodes.length, caps.maxForms);
  const forms = cap(formNodes, caps.maxForms).map((element, index) => ({
    ...base(element as Element, index + 1),
    action: ((element as HTMLFormElement).getAttribute('action') ?? '').slice(0, caps.maxUrlLength),
    method: ((element as HTMLFormElement).getAttribute('method') ?? 'get').toLowerCase(),
    inputNames: Array.from((element as HTMLFormElement).querySelectorAll('input, select, textarea'))
      .slice(0, 60)
      .map((field) => field.getAttribute('name') ?? '')
      .filter(Boolean),
  }));

  // -- tables ----------------------------------------------------------------
  const tableNodes = Array.from(document.querySelectorAll('table'));
  note('tables', tableNodes.length, caps.maxTables);
  const tables = cap(tableNodes, caps.maxTables).map((element, index) => ({
    ...base(element as Element, index + 1),
    // Headings only. Table bodies hold lead data and are never read.
    headings: Array.from(element.querySelectorAll('th, [role="columnheader"]'))
      .slice(0, caps.maxHeadingsPerTable)
      .map((heading) => text(heading.textContent)),
    rowCount: element.querySelectorAll('tr').length,
  }));

  // -- navigation ------------------------------------------------------------
  const navNodes = Array.from(
    document.querySelectorAll('nav a, nav button, [role="navigation"] a, .menu a, .nav a, #menu a, ul.menu li a'),
  );
  note('nav', navNodes.length, caps.maxNavItems);
  const nav = cap(navNodes, caps.maxNavItems).map((element) => ({
    label: accessibleName(element as Element),
    href: (element as Element).getAttribute('href') ?? undefined,
    role: (element as Element).getAttribute('role') ?? undefined,
    depth: 0,
  }));

  return {
    title: document.title ?? '',
    childFrameUrls: Array.from(document.querySelectorAll('frame, iframe'))
      .slice(0, caps.maxRoots)
      .map((frame) => (frame.getAttribute('src') ?? '').slice(0, caps.maxUrlLength)),
    nav,
    buttons,
    inputs,
    selects,
    checkboxes,
    links,
    forms,
    tables,
    truncated,
    passwordFieldsSeen,
  };
}

