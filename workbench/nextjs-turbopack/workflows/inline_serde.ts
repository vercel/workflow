import { InlinePoint } from './_inline_serde_point';
import { processInstanceId } from './inline_start';

/**
 * Custom serde across the workflow VM and steps, for the inline-start e2e:
 * the argument, a step's argument and return value, and the run's return
 * value are `InlinePoint`s, revived from the app's shared serde prelude when
 * the run's first delivery runs inline.
 */
async function movePoint(point: InlinePoint, by: number) {
  'use step';
  return {
    point: new InlinePoint(point.x + by, point.y + by),
    argRevived: point instanceof InlinePoint,
    instance: processInstanceId(),
  };
}

export async function inlineSerdeWorkflow(point: InlinePoint) {
  'use workflow';
  const argRevived = point instanceof InlinePoint;
  const moved = await movePoint(point, 1);
  return {
    argRevivedInWorkflow: argRevived,
    argRevivedInStep: moved.argRevived,
    resultRevivedInWorkflow: moved.point instanceof InlinePoint,
    sum: moved.point.sum(),
    stepInstance: moved.instance,
  };
}
