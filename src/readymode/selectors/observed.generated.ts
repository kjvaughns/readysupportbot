import { SelectorStrategy } from './index';

/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `npm run selectors:apply <report.json>` from a discovery report
 * captured against a real Readymode interface.
 *
 * It is empty, and that is the correct state: no discovery report has been
 * captured and committed yet. An empty file means ReadySupport has not observed
 * the interface, which is exactly what it should say. Populating it with
 * plausible-looking selectors would be a guess wearing the costume of evidence.
 */

export interface ObservedSelector {
  strategy: SelectorStrategy;
  tier: string;
  confidence: number;
  rootName: string;
  rootUrl: string;
}

export const OBSERVED_SOURCE: {
  reportId: string;
  capturedAt: string;
  sha256: string;
  host: string;
} | null = null;

export const OBSERVED_SELECTORS: Record<string, ObservedSelector> = {};
