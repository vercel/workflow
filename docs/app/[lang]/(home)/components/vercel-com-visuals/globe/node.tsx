'use client';

import { clsx } from 'clsx';
import { useGlobeContext } from './context';
import styles from './node.module.css';

interface NodeProps {
  x: number;
  y: number;
  children?: React.ReactNode;
  vercelLogo?: boolean;
  vercelLogoScale?: number;
  vercelLogoOffset?: { x: number; y: number };
  className?: string;
  radius?: number;
  childrenOnly?: boolean;
  securityShield?: boolean;
}

export function Node({
  children,
  x,
  y,
  vercelLogo,
  className,
  radius = 16,
  vercelLogoScale = 0.9,
  vercelLogoOffset = { x: -7.5, y: -8 },
  childrenOnly = false,
  securityShield,
}: NodeProps): React.ReactNode {
  const point = useGlobeContext().matrixRelativeToOrigin(x, y);

  if (securityShield) {
    return (
      <g
        data-testid="node"
        transform={`translate(${point.x - 20}, ${point.y - 20}) scale(${2})`}
      >
        <path
          d="M1 1H19V11C19 15.9706 14.9706 20 10 20V20C5.02944 20 1 15.9706 1 11V1Z"
          fill=""
        />
        <path
          d="M1 0.5C0.723858 0.5 0.5 0.723858 0.5 1V11C0.5 16.2467 4.75329 20.5 10 20.5C15.2467 20.5 19.5 16.2467 19.5 11V1C19.5 0.723858 19.2761 0.5 19 0.5H1Z"
          fill="white"
          stroke="black"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity="0.08"
        />
        <path
          d="M14.25 9.80188V6.5C12.5 6 10 5.5 10 4C10 5.5 7.5 6 5.75 6.5V9.80188C5.75 11.3283 6.52381 12.7507 7.80537 13.5799L10 15L12.1946 13.5799C13.4762 12.7507 14.25 11.3283 14.25 9.80188Z"
          fill="#0070F3"
          stroke="#0070F3"
          strokeLinecap="round"
        />
      </g>
    );
  }

  return (
    <g data-testid="node">
      {children}
      {!childrenOnly && (
        <>
          <circle
            className={clsx(styles.node, className)}
            cx={point.x}
            cy={point.y}
            fill="var(--ds-background-100)"
            r={radius}
            stroke="url(#globe-gradient)"
            vectorEffect="non-scaling-stroke"
          />
          {vercelLogo ? (
            <path
              className={styles.icon}
              clipRule="evenodd"
              d="M8 1L16 15H0L8 1Z"
              fill="currentColor"
              fillRule="evenodd"
              transform={`translate(${point.x + vercelLogoOffset.x}, ${
                point.y + vercelLogoOffset.y
              }) scale(${vercelLogoScale})`}
            />
          ) : (
            <path
              className={styles.icon}
              clipRule="evenodd"
              d="M8.5 0C8.5 0 4.58642 3.74805 3.94122 4.39717C3.86128 4.4776 3.84989 4.60224 3.91398 4.69539C3.97806 4.78854 4.09993 4.82451 4.20557 4.78145L7.90537 3.27345L11.7747 9.36041C11.8406 9.46403 11.9758 9.50133 12.0869 9.44651C12.1979 9.39169 12.2483 9.26276 12.2032 9.1489C11.7103 7.90508 8.5 0 8.5 0ZM6.29304 6.03867C6.35522 5.93334 6.32602 5.79881 6.22554 5.72763C6.12505 5.65645 5.98605 5.67185 5.90418 5.76322C5.12486 6.633 0 12.5 0 12.5C0 12.5 5.18613 13.803 6.03089 13.9939C6.14204 14.0191 6.25587 13.964 6.30355 13.8621C6.35122 13.7603 6.31967 13.6394 6.22796 13.5728L3.1616 11.3431L6.29304 6.03867ZM14.054 7.5893C14.016 7.47964 13.9029 7.4131 13.7867 7.43203C13.6705 7.45096 13.5853 7.5498 13.5853 7.66564V11.3824L6.45275 11.5197C6.32824 11.5221 6.22613 11.6175 6.2173 11.7396C6.20846 11.8618 6.2958 11.9704 6.41871 11.9901C7.68171 12.1927 16 13.5728 16 13.5728C16 13.5728 14.3311 8.38966 14.054 7.5893Z"
              fill="var(--ds-gray-900)"
              fillRule="evenodd"
              transform={`translate(${point.x - 8}, ${point.y - 8}) `}
            />
          )}
        </>
      )}
      {!childrenOnly && (
        <circle
          className={styles.dot}
          cx={point.x}
          cy={point.y}
          fill="var(--ds-gray-900)"
          r="8"
        />
      )}
    </g>
  );
}
