-- ReadySupport 0011 — private storage bucket for workflow evidence.
--
-- Screenshots are captured after each workflow verifies its result. They can
-- contain agent names, emails and license state, so the bucket is private:
-- reachable only with the service role key, and surfaced to Discord as a
-- short-lived signed URL rather than a public link.
--
-- Password fields are masked in the page before any screenshot is taken (see
-- src/readymode/evidence.ts), so a captured image never shows one.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'automation-evidence',
  'automation-evidence',
  false,
  10485760, -- 10 MB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No storage policies are created. With none present, only the service role
-- can read or write the bucket, which is exactly the intent.
