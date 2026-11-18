import { index, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  index('./routes/home.tsx'),
  // The run's page; its Trace, Events and Streams tabs are `?tab=`. The
  // Usage page is a child, so the run header and its data stay mounted when
  // going between the two.
  route('run/:runId', './routes/run-detail.tsx', [
    route('usage', './routes/run-usage.tsx'),
  ]),
  route('api/rpc', './routes/api.rpc.tsx'),
  route('api/stream/:streamId', './routes/api.stream.$streamId.tsx'),
] satisfies RouteConfig;
