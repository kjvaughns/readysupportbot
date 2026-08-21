import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAccess, requireRole } from '../../auth';
import { getStore } from '../../database';
import { recordEvent } from '../../audit';
import { jobQueue, laneKey } from '../../queue';
import {
  credentialInputSchema,
  credentialSummary,
  deleteCredentials,
  hasCredentials,
  storeCredentials,
} from '../../readymode/credentials';
import { openSession, ensureAuthenticated } from '../../readymode/session';
import { ALL_CONTROLS } from '../../readymode/selectors';
import { discoveryReport } from '../../readymode/selectors/discovery';
import { locationLabel } from '../../readymode/selectors/frames';
import { bindProfile, invalidateProfileCache, loadProfile } from '../../readymode/selectors/resolve';
import { runDiscovery } from '../../readymode/discovery';
import { runAuthProbe } from '../../readymode/authProbe';
import { buildInfo } from '../../buildInfo';
import { REQUIRED_NAVIGATION_CONTROLS } from '../../readymode/discovery/readiness';
import {
  BLOCKED_AREAS,
  INSPECTION_DATE,
  INTERFACE_CONTROLS,
} from '../../readymode/interface/registry';
import { isAutomatable } from '../../readymode/interface/types';
import { statusProblems, statusTable } from '../../readymode/interface/workflows';
import { bankCoverage } from '../../knowledge/bank';
import { NotFoundError, ValidationError, toSafeMessage } from '../../security/errors';
import { config } from '../../config';

/**
 * Readymode connection management.
 *
 * Credentials arrive here over HTTPS, are encrypted immediately, and only the
 * ciphertext is stored. No endpoint ever returns the password.
 */
export async function readymodeRoutes(app: FastifyInstance): Promise<void> {
  /** Stores or replaces the Readymode administrator credentials. */
  app.post('/readymode/connect', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);
    const credentials = credentialInputSchema.parse(
      z.object({ organizationId: z.string().optional() }).passthrough().parse(request.body ?? {}),
    );

    const summary = await storeCredentials({
      organizationId: context.organizationId,
      credentials,
      actorId: context.user.id,
    });

    // The response deliberately carries metadata only.
    return { connection: summary, dryRun: config.dryRun };
  });

  /**
   * Re-establishes the session after Readymode asked for human verification.
   * New credentials may be supplied at the same time.
   */
  app.post('/readymode/reconnect', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);
    const body = z
      .object({
        loginUrl: z.string().url().optional(),
        username: z.string().min(1).optional(),
        password: z.string().min(1).optional(),
      })
      .parse(request.body ?? {});

    if (body.loginUrl && body.username && body.password) {
      await storeCredentials({
        organizationId: context.organizationId,
        credentials: {
          loginUrl: body.loginUrl,
          username: body.username,
          password: body.password,
        },
        actorId: context.user.id,
      });
    } else if (!(await hasCredentials(context.organizationId))) {
      return {
        reconnected: false,
        message: 'No Readymode credentials are stored yet. Send the login URL, username and password.',
      };
    }

    const result = await attemptConnection(context.organizationId);

    if (result.ok) {
      jobQueue.resume(laneKey(context.organizationId));
      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.updated',
        message: 'Readymode was reconnected and queued work resumed.',
      });
    }

    return { reconnected: result.ok, message: result.message };
  });

  /** Current connection state. Never includes the password. */
  app.get('/readymode/status', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const store = getStore();
    const connection = await store.getConnection(context.organizationId);
    const credentials = await credentialSummary(context.organizationId);
    const lane = laneKey(context.organizationId);

    return {
      credentials,
      connection: connection
        ? {
            loginUrl: connection.loginUrl,
            username: connection.username,
            status: connection.status,
            lastVerifiedAt: connection.lastVerifiedAt,
            lastError: connection.lastError,
          }
        : null,
      queue: {
        paused: jobQueue.isPaused(lane),
        reason: jobQueue.pauseReason(lane) ?? null,
        depth: jobQueue.depth(lane),
      },
      dryRun: config.dryRun,
    };
  });

  /**
   * Signs in and reports, per capability, what ReadySupport can actually do.
   *
   * Read-only. It changes nothing in Readymode.
   */
  app.post('/readymode/test', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);

    const session = await openSession(context.organizationId).catch(() => null);
    if (!session) {
      return {
        ok: false,
        message: 'A browser session could not be started. Check the Browserbase configuration.',
      };
    }

    try {
      bindProfile(session.page, await loadProfile(context.organizationId));
      await ensureAuthenticated(session);

      const report = await discoveryReport(session.page, ALL_CONTROLS);
      const profile = await getStore().getActiveInterfaceProfile(context.organizationId);
      const unusable = report.capabilities.filter((capability) => !capability.usable);

      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.tested',
        message: 'The Readymode connection was tested.',
        data: {
          resolved: report.resolved.length,
          unresolved: report.unresolved.length,
          unusableCapabilities: unusable.map((capability) => capability.capability),
        },
      });

      return {
        ok: unusable.length === 0,
        signedIn: true,
        dryRun: config.dryRun,
        profile: profile
          ? { id: profile.id, status: profile.status, approvedAt: profile.approvedAt }
          : null,
        // Where the report looked. A control can only be found on the page it
        // lives on, so this is essential context for reading the result.
        pageUrl: session.page.url(),
        frames: report.roots,
        capabilities: report.capabilities,
        controls: report.controls,
        resolved: report.resolved,
        unresolved: report.unresolved,
        message: buildTestMessage(profile !== null, unusable),
      };
    } catch (error) {
      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.tested',
        message: 'The Readymode connection test did not succeed.',
        data: { error: toSafeMessage(error) },
      });
      return { ok: false, signedIn: false, message: toSafeMessage(error) };
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  /**
   * Read-only inspection of the real interface.
   *
   * Walks the interface, records what is there, and proposes selectors the
   * evidence can justify. It never clicks save, submits a form, or changes
   * anything. The result is stored as a proposal for an Owner to approve.
   */
  app.post('/readymode/discover', async (request) => {
    const context = await requireRole(request, ['owner']);
    const body = z
      .object({ maxStops: z.coerce.number().int().min(1).max(20).optional() })
      .parse(request.body ?? {});

    const session = await openSession(context.organizationId).catch(() => null);
    if (!session) {
      return {
        ok: false,
        message: 'A browser session could not be started. Check the Browserbase configuration.',
      };
    }

    try {
      const result = await runDiscovery({
        session,
        organizationId: context.organizationId,
        discoveredBy: context.user.id,
        maxStops: body.maxStops,
      });

      return {
        ok: true,
        // Which build answered. Without this, a fix that was never deployed and
        // a fix that does not work are indistinguishable from out here.
        ...buildInfo(),
        profile: {
          id: result.profile.id,
          status: result.profile.status,
          interfaceVersion: result.profile.interfaceVersion,
          pagesCaptured: result.profile.pagesCaptured,
          controlsTotal: result.profile.controlsTotal,
          controlsProposed: result.profile.controlsProposed,
        },
        // -- what a person needs in order to review this run -------------
        //
        // Stage first: a run that signed in and then failed to crawl used to
        // look exactly like a run that crawled and found nothing.
        authentication: {
          stageReached: result.stageReached,
          dashboardConfirmed: result.dashboardConfirmed,
          continuedPastSessionNotice: result.continuedPastSessionNotice,
          outcome: result.authentication.outcome,
          // Which marker proved the session — not the URL, which proves nothing.
          confirmedBy: result.authentication.marker,
          urlAfterSubmit: result.authentication.urlAfterSubmit,
          urlAfterContinue: result.authentication.urlAfterContinue,
          authenticationLostAt: result.authenticationLostAt,
          stages: result.stages,
        },
        // Safe browser identity, recorded before signing in and again before
        // crawling, so "was it the same session?" is answerable rather than
        // arguable. No cookie name, value, domain or expiry is included.
        session: result.session,
        // Counted honestly: twelve captures of the same login redirect is one
        // page seen twelve times, not twelve pages of interface.
        totals: result.totals,
        readiness: {
          state: result.readiness.readiness,
          summary: result.readiness.summary,
          requiredSatisfied: result.readiness.satisfied,
          requiredMissing: result.readiness.missing,
          loginOnly: result.readiness.loginOnly,
          undocumentedWorkflows: result.readiness.undocumentedWorkflows,
        },
        pagesInspected: result.evidenceSummary.pages,
        framesInspected: result.totals.framesInspected,
        uniqueAuthenticatedPages: result.totals.uniqueAuthenticatedPages,
        loginRedirects: result.totals.loginRedirects,
        screensConfirmed: result.totals.screensConfirmed,
        screensAttempted: result.totals.screensAttempted,
        screens: result.panels.map((panel) => ({
          screen: panel.key,
          label: panel.label,
          route: panel.route,
          finalUrl: panel.finalUrl,
          redirectedToLogin: panel.redirectedToLogin,
          expectedHeading: panel.expectedHeading,
          observedHeading: panel.observedHeading,
          recognizedBy: panel.arrivalEvidence,
          confirmed: panel.confirmed,
          inspected: panel.captured,
          framesInspected: panel.rootsInspected,
          reason: panel.reason ?? null,
        })),
        workflows: result.workflows,
        workflowsInspected: result.workflows.filter((workflow) => workflow.status === 'discovered')
          .length,
        controlsWithoutMatchers: result.controlsWithoutMatchers,
        discoveryErrors: result.errors,
        // Controls, split by what would actually fix each one: a better
        // matcher, another crawl, or nothing at all.
        controls: {
          resolved: result.proposals.filter((proposal) => proposal.confidence >= 60).map((proposal) => ({
            control: proposal.control,
            tier: proposal.tier,
            confidence: proposal.confidence,
            // Pre-formatted, because a review screen joining a page name and a
            // frame name itself rendered "pagepage".
            location: locationLabel(proposal.pageStep, proposal.rootName),
          })),
          ambiguous: result.ambiguous,
          unresolved: result.unresolved,
          withoutMatchers: result.controlsWithoutMatchers,
          notObservable: result.notObservable,
        },
        proposals: result.proposals.map((proposal) => ({
          control: proposal.control,
          tier: proposal.tier,
          confidence: proposal.confidence,
          page: proposal.pageStep,
          frame: proposal.rootName,
          location: locationLabel(proposal.pageStep, proposal.rootName),
          evidence: proposal.evidence,
        })),
        unproposed: result.unproposed,
        // "Nothing proposed" is exactly these three added together. They were
        // reported separately and summed differently, so the same run showed
        // two different figures for the same fact.
        unproposedCount: result.unproposed.length,
        nothingProposed: {
          total: result.unproposed.length,
          ambiguous: result.ambiguous.length,
          unresolved: result.unresolved.length,
          withoutMatchers: result.controlsWithoutMatchers.length,
        },
        unresolvedCount: result.unresolved.length,
        ambiguousCount: result.ambiguous.length,
        notObservableCount: result.notObservable.length,
        counts: {
          pagesCaptured: result.evidenceSummary.pages,
          rootsInspected: result.roots.total,
          rootsFailed: result.roots.failed,
          controlsTotal: result.profile.controlsTotal,
          proposed: result.proposals.length,
          usable: result.profile.controlsProposed,
          ambiguous: result.ambiguous.length,
          unresolved: result.unresolved.length,
          withoutMatchers: result.controlsWithoutMatchers.length,
          notObservable: result.notObservable.length,
        },
        visited: result.visited,
        skipped: result.skipped,
        panels: result.panels,
        loginPageObserved: result.loginPageObserved,
        redactions: result.evidenceSummary,
        message: [
          `Captured ${result.totals.uniqueAuthenticatedPages} authenticated page(s) across ` +
            `${result.totals.framesInspected} frame(s)` +
            `${result.totals.loginRedirects > 0 ? `, plus ${result.totals.loginRedirects} login redirect(s)` : ''}` +
            `${result.roots.failed > 0 ? ` (${result.roots.failed} unreadable)` : ''}.`,
          `Reached ${result.stageReached ?? 'no stage'}; the authenticated dashboard was ` +
            `${result.dashboardConfirmed ? 'confirmed' : 'NOT confirmed'}.`,
          `Confirmed ${result.totals.screensConfirmed} of ${result.totals.screensAttempted} screen(s) attempted.`,
          result.authenticationLostAt
            ? `The session was lost at ${result.authenticationLostAt} and the crawl stopped there.`
            : '',
          `Proposed ${result.profile.controlsProposed} of ${result.profile.controlsTotal} controls;` +
            ` ${result.unproposed.length} unresolved` +
            `${result.notObservable.length > 0 ? `, ${result.notObservable.length} not on screen this run` : ''}.`,
          result.loginPageObserved
            ? ''
            : 'The session was already signed in, so the login controls were not observable.',
          result.readiness.summary,
          'Nothing in Readymode was changed. An Owner must approve this profile before the selectors are used.',
        ]
          .filter(Boolean)
          .join(' '),
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  /**
   * Which build is answering.
   *
   * Unauthenticated and free of side effects: it exists to be called before
   * anything else, so "which backend is this" is settled by the backend itself
   * rather than inferred from behaviour. It returns only a version string and a
   * commit — nothing about the account, the connection or the data.
   */
  app.get('/readymode/auth-version', async () => buildInfo());

  /**
   * Prove what this build does at the login screen, and nothing else.
   *
   * Signs in, looks for Continue with a plain locator that consults no stored
   * selector, presses it, and reports what the screen became. It runs no
   * discovery and creates no profile, so it can be used to settle "is the new
   * authentication code actually running" without any other moving part.
   */
  app.post('/readymode/auth-probe', async (request) => {
    const context = await requireRole(request, ['owner']);

    const session = await openSession(context.organizationId).catch(() => null);
    if (!session) {
      return {
        ok: false,
        ...buildInfo(),
        message: 'A browser session could not be started. Check the Browserbase configuration.',
      };
    }

    try {
      const probe = await runAuthProbe(session);

      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.tested',
        message:
          `Authentication probe: ${probe.candidateCount} Continue candidate(s), ` +
          `outcome=${probe.outcome}, authenticated=${probe.authenticated}.`,
        data: {
          authFlowVersion: probe.authFlowVersion,
          commitShort: probe.commitShort,
          loginOutcome: probe.loginOutcome,
        },
      });

      return {
        ok: true,
        ...probe,
        // The outcome is the answer. The sentence just reads it back.
        message: probe.explanation,
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  /**
   * The honest status table.
   *
   * Every workflow, what evidence stands behind it, and what is blocking the
   * ones that are not ready. Read-only and available to any member, because the
   * point of it is that nobody has to take ReadySupport's word for what works.
   */
  app.get('/readymode/capabilities', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const profile = await getStore().getActiveInterfaceProfile(context.organizationId);

    return {
      // What an Owner has approved for this organization, which is what decides
      // whether a change may run at all.
      approvedProfile: profile
        ? {
            id: profile.id,
            interfaceVersion: profile.interfaceVersion,
            approvedAt: profile.approvedAt,
            verifiedControls: profile.selectors.filter((selector) => selector.verified).length,
          }
        : null,
      // What the recorded inspection supports, independent of any approval.
      inspection: {
        capturedAt: INSPECTION_DATE,
        controls: INTERFACE_CONTROLS.map((control) => ({
          key: control.key,
          page: control.page,
          evidenceStatus: control.evidenceStatus,
          safety: control.safety,
          interfaceVersion: control.interfaceVersion,
          usableForAutomation: isAutomatable(control.evidenceStatus),
          lastVerified: control.lastVerified,
          notes: control.notes ?? null,
        })),
        blockedAreas: BLOCKED_AREAS,
      },
      workflows: statusTable(),
      // Empty unless a workflow claims more evidence than its controls have,
      // which would be a bug in the registry rather than a fact about Readymode.
      statusProblems: statusProblems(),
      knowledge: await knowledgeSummary(),
    };
  });

  /** Discovery profiles, newest first. Metadata only. */
  app.get('/readymode/profiles', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const profiles = await getStore().listInterfaceProfiles(context.organizationId, 20);
    return { profiles };
  });

  app.get('/readymode/profiles/:id', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const params = z.object({ id: z.string().uuid() }).parse(request.params ?? {});

    const profile = await getStore().getInterfaceProfile(params.id);
    if (!profile || profile.organizationId !== context.organizationId) {
      throw new NotFoundError('No such discovery profile.');
    }
    return { profile };
  });

  /** The raw evidence. Owner-only, and every read is audited. */
  app.get('/readymode/profiles/:id/evidence', async (request) => {
    const context = await requireRole(request, ['owner']);
    const params = z.object({ id: z.string().uuid() }).parse(request.params ?? {});

    const profile = await getStore().getInterfaceProfile(params.id);
    if (!profile || profile.organizationId !== context.organizationId) {
      throw new NotFoundError('No such discovery profile.');
    }

    await recordEvent({
      organizationId: context.organizationId,
      type: 'readymode.evidence_read',
      message: 'Raw interface evidence was read.',
      data: { profileId: params.id },
    });

    return { evidence: await getStore().getInterfaceEvidence(params.id) };
  });

  /** Promotes a proposed profile to active. Owner-only. */
  app.post('/readymode/profiles/:id/approve', async (request) => {
    const context = await requireRole(request, ['owner']);
    const params = z.object({ id: z.string().uuid() }).parse(request.params ?? {});

    const profile = await getStore().getInterfaceProfile(params.id);
    if (!profile || profile.organizationId !== context.organizationId) {
      throw new NotFoundError('No such discovery profile.');
    }

    const usable = profile.selectors.filter((selector) => selector.verified);
    if (usable.length === 0) {
      // Approving a profile that identified nothing would create the appearance
      // of a verified interface while changing nothing.
      throw new ValidationError(
        'This profile did not identify any control uniquely, so approving it would not make any capability usable. Run discovery again.',
      );
    }

    // A run that only ever saw the login page proves the credentials work and
    // nothing else. Approving it would mark the interface verified on the
    // strength of a sign-in, which is exactly the false confidence this whole
    // approval step exists to prevent.
    const beyondLogin = usable.filter((selector) => !selector.controlName.startsWith('login.'));
    if (beyondLogin.length === 0) {
      throw new ValidationError(
        'This profile only identified the login controls, so it says nothing about the administrative interface. ' +
          'Run discovery again from a signed-in session so it can reach User Management, License Usage and Lead Management.',
      );
    }

    // Readiness is decided when the run happens, from what it actually reached.
    // Approval reads that decision; it does not get to overrule it.
    if (profile.status === 'incomplete') {
      throw new ValidationError(
        'This profile is incomplete: discovery did not reach or confirm enough of the administrative ' +
          'interface for the result to mean anything. Approving it would not make the unresolved controls ' +
          'usable — it would only hide that they are unresolved. Run discovery again.',
      );
    }

    if (profile.status === 'rejected') {
      throw new ValidationError('This profile was rejected. Run discovery again rather than approving it.');
    }

    const requiredMissing = REQUIRED_NAVIGATION_CONTROLS.filter(
      (control) => !usable.some((selector) => selector.controlName === control),
    );
    if (requiredMissing.length > 0) {
      throw new ValidationError(
        `This profile has not resolved every required navigation control (${requiredMissing.join(', ')}). ` +
          'Approving it would leave those controls unresolved and unusable regardless, so nothing would be gained.',
      );
    }

    const approved = await getStore().approveInterfaceProfile({
      organizationId: context.organizationId,
      profileId: params.id,
      approvedBy: context.user.id,
    });
    invalidateProfileCache(context.organizationId);

    await recordEvent({
      organizationId: context.organizationId,
      type: 'readymode.profile_approved',
      message: `Interface profile approved with ${usable.length} verified control(s).`,
      data: { profileId: params.id, verified: usable.length },
    });

    return { profile: approved };
  });

  app.post('/readymode/profiles/:id/reject', async (request) => {
    const context = await requireRole(request, ['owner']);
    const params = z.object({ id: z.string().uuid() }).parse(request.params ?? {});
    const body = z.object({ notes: z.string().max(500).optional() }).parse(request.body ?? {});

    const profile = await getStore().getInterfaceProfile(params.id);
    if (!profile || profile.organizationId !== context.organizationId) {
      throw new NotFoundError('No such discovery profile.');
    }

    const rejected = await getStore().rejectInterfaceProfile({
      organizationId: context.organizationId,
      profileId: params.id,
      notes: body.notes,
    });
    invalidateProfileCache(context.organizationId);

    await recordEvent({
      organizationId: context.organizationId,
      type: 'readymode.profile_rejected',
      message: 'Interface profile rejected.',
      data: { profileId: params.id },
    });

    return { profile: rejected };
  });

  /** The exact JSON `npm run selectors:apply` consumes. */
  app.get('/readymode/profiles/:id/report', async (request) => {
    const context = await requireRole(request, ['owner']);
    const params = z.object({ id: z.string().uuid() }).parse(request.params ?? {});

    const profile = await getStore().getInterfaceProfile(params.id);
    if (!profile || profile.organizationId !== context.organizationId) {
      throw new NotFoundError('No such discovery profile.');
    }

    return {
      reportId: profile.id,
      capturedAt: profile.discoveredAt,
      host: profile.baseUrl,
      interfaceVersion: profile.interfaceVersion,
      selectors: profile.selectors.map((selector) => ({
        control: selector.controlName,
        strategy: selector.strategy,
        tier: selector.tier,
        confidence: selector.confidence,
        rootName: selector.rootName,
        rootUrl: selector.rootUrl,
        verified: selector.verified,
      })),
    };
  });

  /** Only an Owner may delete stored credentials. */
  app.delete('/readymode/connect', async (request) => {
    const context = await requireRole(request, ['owner']);
    await deleteCredentials({
      organizationId: context.organizationId,
      actorId: context.user.id,
    });
    return { deleted: true };
  });
}

async function attemptConnection(
  organizationId: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await openSession(organizationId).catch(() => null);
  if (!session) {
    return { ok: false, message: 'A browser session could not be started.' };
  }
  try {
    await ensureAuthenticated(session);
    return { ok: true, message: 'Readymode is connected.' };
  } catch (error) {
    return { ok: false, message: toSafeMessage(error) };
  } finally {
    await session.close().catch(() => undefined);
  }
}

function buildTestMessage(
  hasProfile: boolean,
  unusable: Array<{ label: string; missing: string[] }>,
): string {
  if (unusable.length === 0) {
    return 'Signed in, and every capability has controls verified against the real interface.';
  }

  const list = unusable.map((capability) => capability.label).join('; ');
  return hasProfile
    ? `Signed in. These capabilities are not usable yet: ${list}. Run interface discovery again to cover them.`
    : `Signed in, but no discovery profile has been approved, so no change can be made yet. Not usable: ${list}. An Owner should run POST /api/readymode/discover and approve the result.`;
}

/**
 * How much of the Help Center has actually been read.
 *
 * Reported as three separate numbers rather than one percentage, because
 * "147 articles" and "13 articles ReadySupport can answer from" are different
 * claims and only the second one is about what it can do.
 */
async function knowledgeSummary(): Promise<{
  foldersCataloged: number;
  articlesCataloged: number;
  articlesWithContent: number;
  articlesAnswerable: number;
  lastSync: { status: string; finishedAt: string | null } | null;
}> {
  const store = getStore();
  const coverage = bankCoverage();

  let answerable = 0;
  try {
    answerable = (
      await store.listKnowledgeArticles({ statuses: ['normalized', 'fetched'], limit: 1000 })
    ).length;
  } catch {
    // A database that cannot answer is reported as zero read, not as unknown.
  }

  const lastRun = await store.latestKnowledgeSyncRun().catch(() => null);

  return {
    foldersCataloged: coverage.folders,
    articlesCataloged: coverage.articlesCataloged,
    articlesWithContent: coverage.articlesNormalized,
    articlesAnswerable: answerable,
    lastSync: lastRun ? { status: lastRun.status, finishedAt: lastRun.finishedAt } : null,
  };
}
