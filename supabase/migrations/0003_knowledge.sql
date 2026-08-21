-- The Help Center knowledge bank.
--
-- Deliberately separate from the interface tables in 0002. Those hold selectors
-- that a browser acts on; these hold documentation that a person is quoted.
-- Keeping them apart is what stops a sentence in a support article from turning
-- into a click.
--
-- Documentation is product-wide rather than customer data: any signed-in user
-- may read it, and only the backend service role writes it.

create table if not exists public.knowledge_folders (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  folder text not null,
  url text not null,
  -- The Help Center's own count, so a partial crawl is visible as a partial one.
  expected_article_count integer not null default 0,
  known_article_titles text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (folder)
);

create table if not exists public.knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  article_url text not null unique,
  category text not null default '',
  folder text not null default '',
  article_title text not null,

  -- Freshdesk prints this on the article; it is the article's own claim about
  -- when it last changed, not when ReadySupport fetched it.
  last_updated text,

  supported_user_role text[] not null default '{}',
  -- 'Readymode Starter' and 'Readymode iQ' are different products with
  -- different screens. An answer that does not say which one it means is a
  -- wrong answer half the time.
  product text not null default 'Readymode Starter',

  summary text not null default '',
  step_by_step_instructions jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  troubleshooting jsonb not null default '[]'::jsonb,
  related_articles jsonb not null default '[]'::jsonb,
  source_citations jsonb not null default '[]'::jsonb,

  -- 'cataloged'  the title and URL are known; the article has not been read.
  -- 'normalized' the supplied knowledge bank carried a full, structured entry.
  -- 'fetched'    the synchronizer fetched and parsed the real article.
  -- 'failed'     fetching or parsing failed; the previous content is kept.
  -- 'removed'    absent from a complete, successful crawl. Never hard deleted.
  sync_status text not null default 'cataloged'
    check (sync_status in ('cataloged', 'normalized', 'fetched', 'failed', 'removed')),

  -- SHA-256 of the normalized content. Unchanged content is not rewritten, and
  -- a change is what triggers a new version row.
  content_hash text,
  fetched_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_articles_folder_idx on public.knowledge_articles (folder);
create index if not exists knowledge_articles_product_idx on public.knowledge_articles (product);
create index if not exists knowledge_articles_status_idx on public.knowledge_articles (sync_status);

-- Full-text search over the parts of an article worth searching. Deterministic,
-- and it works with no embedding service configured.
create index if not exists knowledge_articles_search_idx
  on public.knowledge_articles
  using gin (
    to_tsvector(
      'english',
      coalesce(article_title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(folder, '') || ' ' ||
      coalesce(category, '')
    )
  );

-- Every previous version of an article, kept for audit. An answer given last
-- month can be explained by the article as it read last month.
create table if not exists public.knowledge_article_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.knowledge_articles (id) on delete cascade,
  content_hash text not null,
  captured_at timestamptz not null default now(),
  -- The whole article as it stood, so a version is readable without
  -- reconstructing it from columns that have since changed shape.
  payload jsonb not null,
  unique (article_id, content_hash)
);

create index if not exists knowledge_article_versions_article_idx
  on public.knowledge_article_versions (article_id, captured_at desc);

create table if not exists public.knowledge_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'partial')),
  folders_seen integer not null default 0,
  articles_seen integer not null default 0,
  articles_fetched integer not null default 0,
  articles_changed integer not null default 0,
  articles_failed integer not null default 0,
  -- True only when discovery covered every folder without error. An article is
  -- only ever marked removed on the strength of a complete pass.
  complete_pass boolean not null default false,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.knowledge_folders enable row level security;
alter table public.knowledge_articles enable row level security;
alter table public.knowledge_article_versions enable row level security;
alter table public.knowledge_sync_runs enable row level security;

-- Public Help Center content: readable by any signed-in user, and not scoped to
-- an organization because it does not belong to one.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'knowledge_folders',
    'knowledge_articles',
    'knowledge_article_versions',
    'knowledge_sync_runs'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      table_name || '_select',
      table_name
    );
  end loop;
end
$$;

-- No insert, update or delete policy exists for authenticated users. Writing is
-- the service role's job, and the service role bypasses row-level security, so
-- the absence of a policy is the restriction.
