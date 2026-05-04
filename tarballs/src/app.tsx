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
            aria-label="Filter packages"
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
    <div class="pm-tabs">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          class="pm-tab"
          aria-label={`Show install commands for ${opt}`}
          aria-pressed={value === opt}
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
        <CopyButton
          text={cmd}
          variant="primary"
          accessibleName={`Copy install command for ${pkg.name}`}
        />
        <a
          class="download-btn"
          href={pkg.url}
          download
          aria-label={`Download ${pkg.name} tarball`}
        >
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
        <CopyButton
          text={cmd}
          variant="icon"
          accessibleName={`Copy install command for ${pkg.name}`}
        />
        <a
          class="icon-btn"
          href={pkg.url}
          download
          aria-label={`Download ${pkg.name} tarball`}
        >
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
        <SizeStats pkg={pkg} />
        <FileTable files={pkg.files} />
      </div>
    </details>
  );
}

/**
 * Two large prominent metric tiles, modeled after packagephobia's `Stats`
 * widget — value + unit on top, uppercase label beneath. The headline
 * numbers a viewer is most likely to want.
 */
function SizeStats({ pkg }: { pkg: PackedPackage }) {
  return (
    <div class="size-stats">
      <SizeStat bytes={pkg.tarballSizeBytes} label="Publish size" />
      <SizeStat bytes={pkg.unpackedSizeBytes} label="Unpacked size" />
    </div>
  );
}

function SizeStat({ bytes, label }: { bytes: number; label: string }) {
  const { value, unit } = splitSize(bytes);
  return (
    <div class="size-stat">
      <div class="size-stat-row">
        <span class="size-stat-value">{value}</span>
        <span class="size-stat-unit">{unit}</span>
      </div>
      <div class="size-stat-label">{label}</div>
    </div>
  );
}

function splitSize(bytes: number): { value: string; unit: string } {
  if (bytes < 1024) return { value: String(bytes), unit: 'B' };
  if (bytes < 1024 * 1024)
    return { value: (bytes / 1024).toFixed(1), unit: 'KiB' };
  return { value: (bytes / 1024 / 1024).toFixed(2), unit: 'MiB' };
}

type SortKey = 'size' | 'path';
type SortDir = 'asc' | 'desc';

interface DisplayFile {
  path: string;
  size: number;
}

function FileTable({ files }: { files: DisplayFile[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('size');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const stripped = useMemo<DisplayFile[]>(
    () =>
      files.map((f) => ({
        path: f.path.startsWith('package/')
          ? f.path.slice('package/'.length)
          : f.path,
        size: f.size,
      })),
    [files]
  );

  const sorted = useMemo(() => {
    const arr = [...stripped];
    arr.sort((a, b) => {
      const cmp =
        sortKey === 'size' ? a.size - b.size : a.path.localeCompare(b.path);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [stripped, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'size' ? 'desc' : 'asc');
    }
  }

  const ariaSortFor = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <div class="file-table-wrap">
      <table class="file-table">
        <thead>
          <tr>
            <th aria-sort={ariaSortFor('path')}>
              <button
                type="button"
                class="sort-btn"
                onClick={() => toggleSort('path')}
              >
                File
                <SortIndicator
                  active={sortKey === 'path'}
                  direction={sortDir}
                />
              </button>
            </th>
            <th class="file-table-size" aria-sort={ariaSortFor('size')}>
              <button
                type="button"
                class="sort-btn"
                onClick={() => toggleSort('size')}
              >
                Size
                <SortIndicator
                  active={sortKey === 'size'}
                  direction={sortDir}
                />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => (
            <tr key={f.path}>
              <td class="file-path">{f.path}</td>
              <td class="file-size">{formatBytes(f.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: SortDir;
}) {
  if (!active) return <span class="sort-indicator" aria-hidden="true" />;
  return (
    <span class="sort-indicator sort-indicator-active" aria-hidden="true">
      {direction === 'asc' ? '↑' : '↓'}
    </span>
  );
}

function CopyButton({
  text,
  variant,
  accessibleName = 'Copy install command',
}: {
  text: string;
  variant: 'primary' | 'icon';
  accessibleName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function handleClick() {
    const success = await writeToClipboard(text);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (success) {
      setFailed(false);
      setCopied(true);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } else {
      setCopied(false);
      setFailed(true);
      timeoutRef.current = setTimeout(() => setFailed(false), 2000);
    }
  }

  const label = copied ? 'Copied' : failed ? 'Copy failed' : accessibleName;

  if (variant === 'icon') {
    return (
      <button
        type="button"
        class="icon-btn"
        data-copied={copied}
        data-failed={failed}
        onClick={handleClick}
        aria-label={label}
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
      data-failed={failed}
      onClick={handleClick}
      aria-label={label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span class="copy-label">
        {copied ? 'Copied' : failed ? 'Failed' : 'Copy'}
      </span>
    </button>
  );
}

/**
 * Try to write `text` to the clipboard. Returns whether the write actually
 * succeeded — both the modern `navigator.clipboard` path and the
 * `execCommand('copy')` fallback can fail (insecure context, denied
 * permission, headless test runner, etc.) and in that case the caller
 * should *not* show a "Copied" success state.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand fallback
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
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
