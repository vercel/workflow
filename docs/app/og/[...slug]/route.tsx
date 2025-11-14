import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { getPageImage, source } from '@/lib/geistdocs/source';

const fontRegex = /src: url\((.+)\) format\('(opentype|truetype)'\)/;

const loadGoogleFont = async (font: string, text: string, weights: string) => {
  const url = `https://fonts.googleapis.com/css2?family=${font}:wght@${weights}&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(url)).text();
  const resource = css.match(fontRegex);

  if (resource) {
    const response = await fetch(resource[1]);
    if (response.status === 200) {
      return await response.arrayBuffer();
    }
  }

  throw new Error('failed to load font data');
};

export const GET = async (
  _request: NextRequest,
  { params }: RouteContext<'/og/[...slug]'>
) => {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));

  if (!page) {
    return new Response('Not found', { status: 404 });
  }

  const { title, description } = page.data;

  const backgroundImagePath = join(
    process.cwd(),
    'app/og/[...slug]/background.png'
  );
  const backgroundImageBuffer = readFileSync(backgroundImagePath);
  const backgroundImageData = backgroundImageBuffer.buffer.slice(
    backgroundImageBuffer.byteOffset,
    backgroundImageBuffer.byteOffset + backgroundImageBuffer.byteLength
  );

  return new ImageResponse(
    <div style={{ fontFamily: 'Geist' }} tw="flex h-full w-full bg-black">
      {/** biome-ignore lint/performance/noImgElement: "Required for Satori" */}
      <img
        alt="Vercel OpenGraph Background"
        height={628}
        src={backgroundImageData as never}
        width={1200}
      />
      <div tw="flex flex-col absolute h-full w-[750px] justify-center left-[50px] pr-[50px] pt-[116px] pb-[86px]">
        <div
          style={{
            textWrap: 'balance',
          }}
          tw="text-5xl font-medium text-white tracking-tight flex leading-[1.1] mb-4"
        >
          {title}
        </div>
        <div
          style={{
            color: '#8B8B8B',
            lineHeight: '44px',
            textWrap: 'balance',
          }}
          tw="text-[32px]"
        >
          {description}
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 628,
      fonts: [
        {
          name: 'Geist',
          data: await loadGoogleFont('Geist', `${title} ${description}`, '400'),
          weight: 400,
        },
        {
          name: 'Geist',
          data: await loadGoogleFont('Geist', `${title} ${description}`, '500'),
          weight: 500,
        },
      ],
    }
  );
};

export const generateStaticParams = () =>
  source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImage(page).segments,
  }));
