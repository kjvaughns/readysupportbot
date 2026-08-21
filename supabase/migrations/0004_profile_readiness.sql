-- Discovery profile review states.
--
-- A run reported success having resolved two login controls and nothing else,
-- and was offered for approval as though it said something about the
-- administrative interface. It did not: signing in proves the credentials work.
--
-- These states make that distinction structural. A profile that never reached
-- the interface is `incomplete` and the approval path refuses it, so approving
-- can no longer be a way to make unresolved controls look usable.
--
--   incomplete       discovery did not reach or confirm enough to mean anything
--   ready_for_review every required navigation control resolved, and every
--                    unsupported workflow states a reason
--   active           an Owner approved it; this is what the runtime resolves
--                    against, and what is presented to people as "approved"
--   rejected         reviewed and refused, or superseded by a better run
--   proposed         rows written before the review states existed
--   superseded       replaced by a later approved profile

alter table public.readymode_interface_profiles
  drop constraint if exists readymode_interface_profiles_status_check;

alter table public.readymode_interface_profiles
  add constraint readymode_interface_profiles_status_check
  check (
    status in ('incomplete', 'ready_for_review', 'proposed', 'active', 'superseded', 'rejected')
  );

-- Existing profiles that only ever resolved login controls are rejected rather
-- than deleted. The run happened, and the evidence of what it could and could
-- not see is worth keeping; what it must not be is approvable.
update public.readymode_interface_profiles as profile
set
  status = 'rejected',
  notes = coalesce(profile.notes || ' ', '') ||
    'Rejected automatically: this run resolved only login controls, so it says nothing about the ' ||
    'administrative interface. Discovery has since been rewritten to crawl the authenticated screens.'
where
  profile.status not in ('rejected', 'superseded')
  and not exists (
    select 1
    from public.readymode_selector_versions as selector
    where selector.profile_id = profile.id
      and selector.verified
      and selector.control_name not like 'login.%'
  );
