const KEYFRAMES = `@keyframes wf-spinner-fade{0%{opacity:1}100%{opacity:.15}}`;

/**
 * Spinner matching Geist's multi-line fade spinner.
 * At size ≤12: 8 lines, ≤16: 10 lines, else: 12 lines.
 */
export function Spinner({
  size = 14,
  color,
}: {
  size?: number;
  color?: string;
}) {
  const config =
    size <= 12
      ? {
          count: 8,
          angle: 45,
          delays: [-875, -750, -625, -500, -375, -250, -125, 0],
          duration: 1000,
          lineW: 3,
          lineH: 1.5,
        }
      : size <= 16
        ? {
            count: 10,
            angle: 36,
            delays: [-900, -800, -700, -600, -500, -400, -300, -200, -100, 0],
            duration: 1000,
            lineW: 4,
            lineH: 1.5,
          }
        : {
            count: 12,
            angle: 30,
            delays: [
              -1100, -1000, -900, -800, -700, -600, -500, -400, -300, -200,
              -100, 0,
            ],
            duration: 1200,
            lineW: size * 0.24,
            lineH: size * 0.08,
          };

  return (
    <span
      style={{
        display: 'inline-flex',
        position: 'relative',
        width: size,
        height: size,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      {config.delays.map((delay, i) => (
        <span
          key={delay}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: config.lineW,
            height: config.lineH,
            marginLeft: -config.lineW / 2,
            marginTop: -config.lineH / 2,
            borderRadius: 1,
            backgroundColor: color ?? 'var(--ds-gray-700)',
            transform: `rotate(${i * config.angle}deg) translate(${size * 0.36}px)`,
            animation: `wf-spinner-fade ${config.duration}ms linear infinite`,
            animationDelay: `${delay}ms`,
          }}
        />
      ))}
    </span>
  );
}
