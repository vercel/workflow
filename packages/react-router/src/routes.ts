import { route, type RouteConfigEntry } from '@react-router/dev/routes';

export function workflowRoutes(): RouteConfigEntry[] {
  return [
    route('.well-known/workflow/v1/flow', './routes/.workflow/flow.ts'),
    route('.well-known/workflow/v1/step', './routes/.workflow/step.ts'),
    route(
      '.well-known/workflow/v1/webhook/:token',
      './routes/.workflow/webhook/[token].ts'
    ),
  ];
}
