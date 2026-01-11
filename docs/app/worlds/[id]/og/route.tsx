import { ImageResponse } from 'next/og';
import { getWorldData, getWorldIds } from '@/lib/worlds-data';

export const runtime = 'edge';

export async function generateStaticParams() {
  const ids = getWorldIds();
  return ids.map((id) => ({ id }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = await getWorldData(id);

  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  const { world } = data;

  // Badge color based on world type
  const badgeColor = world.type === 'official' ? '#3b82f6' : '#8b5cf6';
  const badgeText = world.type === 'official' ? 'Official' : 'Community';

  return new ImageResponse(
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0a0a0a',
        padding: '60px 80px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Top section with logo */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '40px',
        }}
      >
        {/* Workflow logo */}
        <svg
          fill="none"
          height={32}
          viewBox="0 0 305 234"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Workflow DevKit Logo"
        >
          <g fill="#ffffff">
            <path d="m125.776 0c-4.847.00001649-8.776 3.9291-8.776 8.77539v52.64941c0 4.8463 3.929 8.7754 8.776 8.7754h35.099l.378.0049c7.779.1972 14.048 6.4683 14.242 14.248l.005.3721v58.4998c0 4.846 3.929 8.776 8.776 8.776h35.099l.378.004c7.777.198 14.045 6.466 14.242 14.243l.005.378v58.499c0 4.846 3.929 8.775 8.776 8.775h52.649c4.846 0 8.775-3.929 8.775-8.775v-52.65c0-4.846-3.929-8.775-8.775-8.775h-35.175c-7.916-.04-14.345-6.37-14.545-14.247l-.005-.377v-58.5002c0-4.8463-3.929-8.7754-8.775-8.7754h-35.1c-7.951 0-14.42-6.3453-14.62-14.2481l-.005-.3769v-58.50001c0-4.84629-3.929-8.7753735-8.775-8.77539z" />
            <path d="m67.2755 81.9004c-4.8462 0-8.7753 3.9291-8.7753 8.7754v52.6492c.0002 4.846 3.9292 8.776 8.7753 8.776h35.0995l.378.004c7.777.198 14.045 6.466 14.242 14.243l.005.378v58.499c0 4.846 3.929 8.775 8.776 8.775h52.649c4.846 0 8.775-3.929 8.775-8.775v-52.65c0-4.846-3.929-8.775-8.775-8.775h-35.175c-7.916-.04-14.345-6.37-14.545-14.247l-.005-.377v-58.5002c0-4.8463-3.929-8.7754-8.775-8.7754z" />
            <path d="m8.77454 163.8c-4.8461 0-8.77441793 3.929-8.77441793 8.775v52.65c0 4.846 3.92831793 8.775 8.77441793 8.775h52.65036c4.8463 0 8.7754-3.929 8.7754-8.775v-52.65c0-4.846-3.9291-8.775-8.7754-8.775z" />
          </g>
        </svg>
        <span
          style={{
            color: '#ffffff',
            fontSize: '24px',
            fontWeight: 600,
          }}
        >
          Workflow DevKit
        </span>
      </div>

      {/* Main content */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          justifyContent: 'center',
        }}
      >
        {/* Badge */}
        <div
          style={{
            display: 'flex',
            marginBottom: '20px',
          }}
        >
          <span
            style={{
              backgroundColor: badgeColor,
              color: '#ffffff',
              fontSize: '14px',
              fontWeight: 600,
              padding: '6px 14px',
              borderRadius: '9999px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {badgeText}
          </span>
        </div>

        {/* Title */}
        <h1
          style={{
            color: '#ffffff',
            fontSize: '72px',
            fontWeight: 700,
            lineHeight: 1.1,
            margin: 0,
            marginBottom: '24px',
            letterSpacing: '-0.02em',
          }}
        >
          {world.name} World
        </h1>

        {/* Description */}
        <p
          style={{
            color: '#a1a1aa',
            fontSize: '28px',
            lineHeight: 1.4,
            margin: 0,
            maxWidth: '900px',
          }}
        >
          {world.description}
        </p>
      </div>

      {/* Bottom URL */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <span
          style={{
            color: '#71717a',
            fontSize: '20px',
          }}
        >
          useworkflow.dev/worlds/{id}
        </span>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
    }
  );
}
