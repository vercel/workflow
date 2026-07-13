type BunRuntime = {
  version: string;
  revision: string;
};

export function GET() {
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  const processVersion = (
    process.versions as Record<string, string | undefined>
  ).bun;

  if (!bun || !processVersion) {
    return Response.json(
      { error: 'Bun runtime is not active' },
      { status: 500 }
    );
  }

  return Response.json({
    version: bun.version,
    revision: bun.revision,
    processVersion,
  });
}
