export function getHighResInMs([seconds, nanoseconds]: [
  number,
  number,
]): number {
  return seconds * 1000 + nanoseconds / 1e6;
}

export function getMsInHighRes(ms: number): [number, number] {
  return [Math.floor(ms / 1000), (ms % 1000) * 1000];
}

const durationFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

export function formatDuration(ms: number): string {
  if (ms === 0) {
    return '0';
  } else if (ms >= 1000) {
    return `${durationFormatter.format(ms / 1000)}s`;
  }
  return `${durationFormatter.format(ms)}ms`;
}

const timeSelectionFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatTimeSelection(ms: number): string {
  if (ms >= 1000) {
    return `${timeSelectionFormatter.format(ms / 1000)}s`;
  }
  return `${timeSelectionFormatter.format(ms)}ms`;
}
