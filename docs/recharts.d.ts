// Recharts 2.x class components lack a `props` property, which React 19's
// stricter JSX types require. This augmentation adds it so TS stops reporting
// "JSX element class does not support attributes because it does not have a
// 'props' property."
//
// Safe to remove once recharts ships native React 19 type support.

import type { CategoricalChartProps } from 'recharts/types/chart/generateCategoricalChart';
import type {
  AreaProps,
  LineProps,
  XAxisProps,
  YAxisProps,
  CartesianGridProps,
} from 'recharts';

declare module 'recharts' {
  interface XAxis {
    props: XAxisProps;
  }
  interface YAxis {
    props: YAxisProps;
  }
  interface Area {
    props: AreaProps;
  }
  interface Line {
    props: LineProps;
  }
  interface CartesianGrid {
    props: CartesianGridProps;
  }
  interface ComposedChart {
    props: CategoricalChartProps;
  }
}
