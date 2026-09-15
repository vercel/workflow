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
      className="relative inline-flex"
      style={{
        width: size,
        height: size,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      {config.delays.map((delay, i) => (
        <span
          key={delay}
          className="absolute top-1/2 left-1/2 rounded-[1px] bg-gray-700 [animation-iteration-count:infinite] [animation-name:wf-spinner-fade] [animation-timing-function:linear]"
          style={{
            width: config.lineW,
            height: config.lineH,
            marginLeft: -config.lineW / 2,
            marginTop: -config.lineH / 2,
            backgroundColor: color,
            transform: `rotate(${i * config.angle}deg) translate(${size * 0.36}px)`,
            animationDuration: `${config.duration}ms`,
            animationDelay: `${delay}ms`,
          }}
        />
      ))}
    </span>
  );
}
