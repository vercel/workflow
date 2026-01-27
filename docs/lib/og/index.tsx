import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export type OgImageOptions = {
  title: string;
  description?: string;
  badge?: {
    text: string;
    color: string;
  };
};

let fontsPromise: Promise<{ regular: Buffer; semibold: Buffer }> | null = null;
let backgroundPromise: Promise<ArrayBuffer> | null = null;

const loadFonts = () => {
  if (!fontsPromise) {
    fontsPromise = Promise.all([
      readFile(join(process.cwd(), 'lib/og/assets/geist-sans-regular.ttf')),
      readFile(join(process.cwd(), 'lib/og/assets/geist-sans-semibold.ttf')),
    ]).then(([regular, semibold]) => ({ regular, semibold }));
  }
  return fontsPromise;
};

const loadBackground = () => {
  if (!backgroundPromise) {
    backgroundPromise = readFile(
      join(process.cwd(), 'lib/og/assets/background.png')
    ).then((buf) =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );
  }
  return backgroundPromise;
};

export const createOgImage = async ({
  title,
  description,
  badge,
}: OgImageOptions) => {
  const [fonts, backgroundImage] = await Promise.all([
    loadFonts(),
    loadBackground(),
  ]);

  return new ImageResponse(
    <div style={{ fontFamily: 'Geist' }} tw="flex h-full w-full">
      {/** biome-ignore lint/performance/noImgElement: Required for Satori */}
      <img
        alt="Background"
        height={628}
        src={backgroundImage as never}
        width={1200}
      />
      <div tw="flex flex-col absolute h-full w-[750px] left-[82px] top-[164px] pb-[86px] pt-[120px] max-w-2xl">
        {badge && (
          <span
            style={{ backgroundColor: badge.color }}
            tw="text-sm font-semibold text-white px-4 py-1.5 rounded-full mb-5 self-start uppercase tracking-wide"
          >
            {badge.text}
          </span>
        )}
        <div
          style={{ textWrap: 'balance', letterSpacing: '-0.04em' }}
          tw="text-7xl font-medium text-white flex leading-[1.1] mb-4 text-[#ededed]"
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              color: '#8B8B8B',
              lineHeight: '38px',
              textWrap: 'balance',
            }}
            tw="text-[28px] text-[#A0A0A0]"
          >
            {description}
          </div>
        )}
      </div>
    </div>,
    {
      width: 1200,
      height: 628,
      fonts: [
        {
          name: 'Geist',
          data: fonts.regular,
          weight: 400,
        },
        {
          name: 'Geist',
          data: fonts.semibold,
          weight: 500,
        },
      ],
    }
  );
};
