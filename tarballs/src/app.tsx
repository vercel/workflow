import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  type Catalog,
  type PackageManager,
  type PackedPackage,
  buildInstallCommand,
  formatBytes,
} from './catalog';
import {
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  CommitIcon,
  CopyIcon,
  DownloadIcon,
  PrIcon,
  SearchIcon,
} from './icons';

const FEATURED_PACKAGE = 'workflow';

export function App({ catalog }: { catalog: Catalog }) {
  const featured = catalog.packages.find((p) => p.name === FEATURED_PACKAGE);
  const others = useMemo(
    () =>
      catalog.packages
        .filter((p) => p.name !== FEATURED_PACKAGE)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [catalog.packages]
  );

  const [pm, setPm] = useState<PackageManager>('pnpm');
  const [filter, setFilter] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // `/` focuses the filter input.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return others;
    return others.filter((p) => p.name.toLowerCase().includes(q));
  }, [others, filter]);

  const totalSize = catalog.packages.reduce(
    (sum, p) => sum + p.tarballSizeBytes,
    0
  );

  return (
    <div class="container">
      <Header catalog={catalog} totalSize={totalSize} />

      {featured && <FeaturedCard pkg={featured} pm={pm} />}

      <h2 class="section-title">Other packages</h2>
      <div class="controls">
        <PmTabs value={pm} onChange={setPm} />
        <label class="search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            placeholder="Filter packages…"
            autoComplete="off"
            value={filter}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div class="pkg-list">
        {filtered.length === 0 ? (
          <div class="empty">No packages match that filter.</div>
        ) : (
          filtered.map((p) => <PackageRow key={p.name} pkg={p} pm={pm} />)
        )}
      </div>

      <Footer catalog={catalog} totalSize={totalSize} />
    </div>
  );
}

function Header({
  catalog,
  totalSize,
}: {
  catalog: Catalog;
  totalSize: number;
}) {
  const { build } = catalog;
  return (
    <header class="page">
      <h1>Workflow SDK preview tarballs</h1>
      <p class="lede">
        Pre-release builds of every public package, packed straight from the
        latest commit. Drop one into a project to test before publish.
      </p>
      <div class="meta-chips">
        {build.commitUrl ? (
          <a class="chip" href={build.commitUrl} target="_blank" rel="noopener">
            <CommitIcon />
            <code>{build.shortSha}</code>
          </a>
        ) : (
          <span class="chip">
            <CommitIcon />
            <code>{build.shortSha}</code>
          </span>
        )}
        {build.branch &&
          (build.branchUrl ? (
            <a
              class="chip"
              href={build.branchUrl}
              target="_blank"
              rel="noopener"
            >
              <BranchIcon /> {build.branch}
            </a>
          ) : (
            <span class="chip">
              <BranchIcon /> {build.branch}
            </span>
          ))}
        {build.pr && build.prUrl && (
          <a class="chip" href={build.prUrl} target="_blank" rel="noopener">
            <PrIcon /> PR #{build.pr}
          </a>
        )}
        <span class="chip">
          <time dateTime={build.builtAt}>{build.builtAt}</time>
        </span>
        <span class="chip">
          {catalog.packages.length} packages · {formatBytes(totalSize)}
        </span>
      </div>
      <details class="about">
        <summary>What is this?</summary>
        <p>
          Each commit on the <code>workflow</code> repo produces a deployment
          that builds and serves a tarball for every public package under{' '}
          <code>packages/*</code>. Versions are rewritten to{' '}
          <code>&lt;version&gt;-&lt;sha&gt;</code> and workspace dependencies
          are rewritten to point at sibling tarballs on this same deployment, so
          installing a single tarball pulls in the rest transitively.
        </p>
        <p>
          Use these to verify a fix in a downstream project before publishing to
          npm. Every tarball URL is a stable, immutable artifact tied to a
          specific commit.
        </p>
      </details>
    </header>
  );
}

function PmTabs({
  value,
  onChange,
}: {
  value: PackageManager;
  onChange: (pm: PackageManager) => void;
}) {
  const options: PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun'];
  return (
    <div class="pm-tabs" role="tablist" aria-label="Package manager">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          class="pm-tab"
          role="tab"
          aria-selected={value === opt}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function FeaturedCard({ pkg, pm }: { pkg: PackedPackage; pm: PackageManager }) {
  const cmd = buildInstallCommand(pm, pkg.url);
  return (
    <section class="featured">
      <div class="featured-header">
        <span class="featured-badge">Main package</span>
        <span class="featured-name">{pkg.name}</span>
        <span class="featured-version">v{pkg.version}</span>
        <span class="featured-size">
          · {formatBytes(pkg.tarballSizeBytes)} ·{' '}
          {formatBytes(pkg.unpackedSizeBytes)} unpacked · {pkg.fileCount} files
        </span>
      </div>
      {pkg.description && <p class="featured-desc">{pkg.description}</p>}
      <div class="install-block">
        <code class="install-cmd">{cmd}</code>
        <CopyButton text={cmd} variant="primary" />
        <a class="download-btn" href={pkg.url} download>
          <DownloadIcon />
          <span>Download</span>
        </a>
      </div>
      <PackageContents pkg={pkg} variant="featured" />
    </section>
  );
}

function PackageRow({ pkg, pm }: { pkg: PackedPackage; pm: PackageManager }) {
  const cmd = buildInstallCommand(pm, pkg.url);
  return (
    <div class="pkg-row" data-name={pkg.name}>
      <div class="pkg-info">
        <div class="pkg-name">{pkg.name}</div>
        <div class="pkg-meta">
          v{pkg.version} · {formatBytes(pkg.tarballSizeBytes)} ·{' '}
          {formatBytes(pkg.unpackedSizeBytes)} unpacked · {pkg.fileCount} files
        </div>
      </div>
      <code class="pkg-cmd">{cmd}</code>
      <div class="pkg-actions">
        <CopyButton text={cmd} variant="icon" />
        <a class="icon-btn" href={pkg.url} download aria-label="Download">
          <DownloadIcon />
        </a>
      </div>
      <PackageContents pkg={pkg} variant="row" />
    </div>
  );
}

function PackageContents({
  pkg,
  variant,
}: {
  pkg: PackedPackage;
  variant: 'featured' | 'row';
}) {
  if (pkg.files.length === 0) return null;

  // Group files by their top-level directory under `package/`. The leading
  // `package/` prefix is just the npm convention for tarball contents and
  // doesn't add information for a viewer.
  const grouped = useMemo(() => groupByTopLevel(pkg.files), [pkg.files]);

  return (
    <details class={`contents contents-${variant}`}>
      <summary>
        <ChevronIcon />
        <span>What's inside?</span>
        <span class="contents-summary-meta">
          {pkg.fileCount} files · {formatBytes(pkg.unpackedSizeBytes)} unpacked
        </span>
      </summary>
      <div class="contents-body">
        <ol class="contents-groups">
          {grouped.map((group) => (
            <ContentsGroup
              key={group.label}
              group={group}
              total={pkg.unpackedSizeBytes}
            />
          ))}
        </ol>
      </div>
    </details>
  );
}

interface FileGroup {
  label: string;
  size: number;
  files: { path: string; size: number }[];
}

function groupByTopLevel(files: { path: string; size: number }[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    // Strip `package/` prefix.
    const stripped = f.path.startsWith('package/')
      ? f.path.slice('package/'.length)
      : f.path;
    const slash = stripped.indexOf('/');
    const label = slash === -1 ? '(root)' : stripped.slice(0, slash);
    const inner = slash === -1 ? stripped : stripped.slice(slash + 1);
    const existing = groups.get(label);
    if (existing) {
      existing.size += f.size;
      existing.files.push({ path: inner, size: f.size });
    } else {
      groups.set(label, {
        label,
        size: f.size,
        files: [{ path: inner, size: f.size }],
      });
    }
  }
  const arr = Array.from(groups.values());
  for (const g of arr) {
    g.files.sort((a, b) => b.size - a.size);
  }
  arr.sort((a, b) => b.size - a.size);
  return arr;
}

function ContentsGroup({ group, total }: { group: FileGroup; total: number }) {
  const pct = total === 0 ? 0 : (group.size / total) * 100;
  return (
    <li class="contents-group">
      <div class="contents-group-header">
        <span class="contents-group-label">{group.label}</span>
        <span class="contents-group-bar" aria-hidden="true">
          <span
            class="contents-group-bar-fill"
            style={{ width: `${pct.toFixed(1)}%` }}
          />
        </span>
        <span class="contents-group-size">
          {formatBytes(group.size)}{' '}
          <span class="contents-group-pct">{pct.toFixed(1)}%</span>
        </span>
      </div>
      <ol class="contents-files">
        {group.files.slice(0, 50).map((f) => (
          <li key={f.path}>
            <span class="contents-file-path">{f.path}</span>
            <span class="contents-file-size">{formatBytes(f.size)}</span>
          </li>
        ))}
        {group.files.length > 50 && (
          <li class="contents-file-more">
            …and {group.files.length - 50} more
          </li>
        )}
      </ol>
    </li>
  );
}

function CopyButton({
  text,
  variant,
}: {
  text: string;
  variant: 'primary' | 'icon';
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        ta.remove();
      }
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }

  if (variant === 'icon') {
    return (
      <button
        type="button"
        class="icon-btn"
        data-copied={copied}
        onClick={handleClick}
        aria-label={copied ? 'Copied' : 'Copy install command'}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    );
  }

  return (
    <button
      type="button"
      class="copy-btn"
      data-copied={copied}
      onClick={handleClick}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span class="copy-label">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function Footer({
  catalog,
  totalSize,
}: {
  catalog: Catalog;
  totalSize: number;
}) {
  const { build } = catalog;
  return (
    <footer class="page">
      Built from{' '}
      {build.commitUrl ? (
        <a href={build.commitUrl} target="_blank" rel="noopener">
          {build.shortSha}
        </a>
      ) : (
        <code>{build.shortSha}</code>
      )}{' '}
      · {catalog.packages.length} packages totaling {formatBytes(totalSize)}
    </footer>
  );
}
