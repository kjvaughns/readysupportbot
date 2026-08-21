-- Profiles from runs that never confirmed the authenticated dashboard.
--
-- `ensureAuthenticated` used to accept a signal that Readymode's login page
-- also satisfies — a nav element, and the words "sign out". So it opened the
-- login page, concluded a session was already open, and returned without
-- entering the credentials. Every administrative route then redirected back to
-- login, and discovery captured the same login page twelve times while
-- reporting that it had crawled the interface.
--
-- Any profile from before that fix says nothing about the administrative
-- interface. They are rejected rather than deleted: the evidence of what a run
-- could and could not see is worth keeping, and what it must not be is
-- approvable.

update public.readymode_interface_profiles as profile
set
  status = 'rejected',
  notes = coalesce(profile.notes || ' ', '') ||
    'Rejected automatically: the authenticated dashboard was never confirmed, so every capture in ' ||
    'this run was the login page. Authentication is now proved by the signed-in shell, and a page ' ||
    'showing a password field is never treated as authenticated.'
where
  profile.status not in ('rejected', 'superseded')
  and not exists (
    select 1
    from public.readymode_selector_versions as selector
    where selector.profile_id = profile.id
      and selector.verified
      and selector.control_name not like 'login.%'
  );
