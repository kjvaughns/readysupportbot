import { describe, expect, it } from 'vitest';
import { buildFakePage } from './support/fakePage';
import { allText, listSearchRoots } from '../src/readymode/selectors/frames';
import { anyPresent, countMatches, tryDiscover } from '../src/readymode/selectors/discovery';
import { LOGIN_CONTROLS, HUMAN_VERIFICATION_CONDITIONS } from '../src/readymode/selectors';

/**
 * The regression these cover: Readymode's legacy interface puts its content in
 * frames, and resolution used to look at the top-level page only.
 */

const loginInAFrame = () =>
  buildFakePage([
    { name: 'main', url: 'https://rm.test/', bodyText: 'Readymode', elements: [] },
    {
      name: 'body',
      url: 'https://rm.test/login',
      bodyText: 'Please sign in',
      elements: [
        { label: 'Username', css: ['input[name="username"]'], visible: true },
        { label: 'Password', css: ['input[type="password"]'], visible: true },
      ],
    },
  ]);

describe('search roots', () => {
  it('includes the page and every usable frame, main first', () => {
    const { page } = loginInAFrame();
    const roots = listSearchRoots(page);
    expect(roots).toHaveLength(2);
    expect(roots[0].url()).toBe('https://rm.test/');
  });

  it('drops detached and blank frames', () => {
    const { page } = buildFakePage([
      { name: 'main', url: 'https://rm.test/', elements: [] },
      { name: 'gone', url: 'https://rm.test/x', detached: true, elements: [] },
      { name: 'blank', url: 'about:blank', elements: [] },
    ]);
    expect(listSearchRoots(page)).toHaveLength(1);
  });

  it('reads text from every frame, not just the page', async () => {
    const { page } = loginInAFrame();
    const text = await allText(page);
    expect(text).toContain('Readymode');
    expect(text).toContain('Please sign in');
  });
});

describe('control resolution across frames', () => {
  it('finds a login field that lives inside a frame', async () => {
    const { page } = loginInAFrame();
    const result = await tryDiscover(page, LOGIN_CONTROLS.username, { timeoutMs: 10 });

    expect(result.resolved).not.toBeNull();
    expect(result.resolved?.rootName).toBe('frame:body');
  });

  it('refuses when the same control is visible in two frames', async () => {
    const { page } = buildFakePage([
      { name: 'main', url: 'https://rm.test/', elements: [] },
      {
        name: 'left',
        url: 'https://rm.test/a',
        elements: [{ label: 'Username', css: ['input[name="username"]'], visible: true }],
      },
      {
        name: 'right',
        url: 'https://rm.test/b',
        elements: [{ label: 'Username', css: ['input[name="username"]'], visible: true }],
      },
    ]);

    const result = await tryDiscover(page, LOGIN_CONTROLS.username, { timeoutMs: 10 });
    expect(result.resolved).toBeNull();
    expect(result.hits.some((hit) => hit.note?.includes('2 frames'))).toBe(true);
  });

  it('ignores a hidden duplicate and resolves the visible one', async () => {
    const { page } = buildFakePage([
      { name: 'main', url: 'https://rm.test/', elements: [] },
      {
        name: 'visible',
        url: 'https://rm.test/a',
        elements: [{ label: 'Username', css: ['input[name="username"]'], visible: true }],
      },
      {
        name: 'hidden',
        url: 'https://rm.test/b',
        elements: [{ label: 'Username', css: ['input[name="username"]'], visible: false }],
      },
    ]);

    const result = await tryDiscover(page, LOGIN_CONTROLS.username, { timeoutMs: 10 });
    expect(result.resolved?.rootName).toBe('frame:visible');
  });

  it('reports a control that is present but not visible, rather than calling it missing', async () => {
    const { page } = buildFakePage([
      {
        name: 'main',
        url: 'https://rm.test/',
        elements: [{ label: 'Username', css: ['input[name="username"]'], visible: false }],
      },
    ]);

    const result = await tryDiscover(page, LOGIN_CONTROLS.username, { timeoutMs: 10 });
    expect(result.resolved).toBeNull();
    // The distinction matters: hidden needs a different fix than absent.
    expect(result.hits.some((hit) => hit.note?.includes('not visible'))).toBe(true);
  });

  it('counts visible matches separately from attached ones', async () => {
    const { page } = buildFakePage([
      {
        name: 'main',
        url: 'https://rm.test/',
        elements: [
          { css: ['input[type="password"]'], visible: false },
          { css: ['input[type="password"]'], visible: false },
        ],
      },
    ]);

    const locator = page.locator('input[type="password"]');
    const counted = await countMatches(locator, 10);
    expect(counted.attached).toBe(2);
    expect(counted.visible).toBe(0);
  });

  it('detects a captcha nested inside a frame', async () => {
    const { page } = buildFakePage([
      { name: 'main', url: 'https://rm.test/', elements: [] },
      {
        name: 'body',
        url: 'https://rm.test/login',
        elements: [
          {
            css: ['iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha'],
            visible: true,
          },
        ],
      },
    ]);

    expect(await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 10)).toBe(true);
  });

  it('tags a built-in match as a guess, not as evidence', async () => {
    const { page } = loginInAFrame();
    const result = await tryDiscover(page, LOGIN_CONTROLS.username, { timeoutMs: 10 });
    expect(result.resolved?.source).toBe('builtin');
  });
});
