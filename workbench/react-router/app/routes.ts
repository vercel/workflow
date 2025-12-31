import type { RouteConfig } from '@react-router/dev/routes';
import { flatRoutes } from '@react-router/fs-routes';
import { workflowRoutes } from 'workflow/react-router';

export default [
  ...workflowRoutes(),
  ...(await flatRoutes({
    ignoredRouteFiles: ['**/.workflow/**'],
  })),
] satisfies RouteConfig;
