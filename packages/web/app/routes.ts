import { index, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  index('./routes/home.tsx'),
  route('run/:runId', './routes/run-detail.tsx'),
  route('api/rpc', './routes/api.rpc.tsx'),
  route('api/stream/:streamId', './routes/api.stream.$streamId.tsx'),
] satisfies RouteConfig;
