import { createRequire } from 'node:module';

const native = createRequire(import.meta.url)(
  './workflow-node-native-probe.node'
);

export const NativeSqliteWorld = native.NativeSqliteWorld;
export const NativeTypeTagSentinel = native.NativeTypeTagSentinel;
export const nativeInfo = native.nativeInfo;
export const nativePanicProbe = native.nativePanicProbe;
export const roundTripContext = native.roundTripContext;
