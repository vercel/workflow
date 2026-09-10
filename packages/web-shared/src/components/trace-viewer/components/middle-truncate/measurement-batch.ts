interface MeasurementTask<T> {
  measure: (measurement: T) => void;
  read: () => T | null;
}

type PendingMeasurement = () => (() => void) | null;

const pendingMeasurements = new Map<object, PendingMeasurement>();
let measurementFrame = 0;

function flushMeasurements(): void {
  measurementFrame = 0;

  const reads = [...pendingMeasurements.values()];
  pendingMeasurements.clear();
  const measures = reads.map((read) => read());

  for (const measure of measures) {
    measure?.();
  }
}

function scheduleMeasurement<T>(
  key: object,
  { read, measure }: MeasurementTask<T>
): void {
  pendingMeasurements.set(key, () => {
    const measurement = read();
    return measurement === null ? null : () => measure(measurement);
  });

  if (measurementFrame === 0) {
    measurementFrame = requestAnimationFrame(flushMeasurements);
  }
}

function cancelMeasurement(key: object): void {
  pendingMeasurements.delete(key);

  if (pendingMeasurements.size === 0 && measurementFrame !== 0) {
    cancelAnimationFrame(measurementFrame);
    measurementFrame = 0;
  }
}

export { cancelMeasurement, scheduleMeasurement };
export type { MeasurementTask };
