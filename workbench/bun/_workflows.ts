import * as demo from './workflows/0_demo.ts';
import * as simple from './workflows/1_simple.ts';
import * as controlFlow from './workflows/2_control_flow.ts';
import * as streams from './workflows/3_streams.ts';
import * as ai from './workflows/4_ai.ts';
import * as hooks from './workflows/5_hooks.ts';
import * as batching from './workflows/6_batching.ts';
import * as duplicate from './workflows/98_duplicate_case.ts';
import * as e2e from './workflows/99_e2e.ts';

export const allWorkflows = {
  'workflows/0_calc.ts': demo,
  'workflows/1_simple.ts': simple,
  'workflows/2_control_flow.ts': controlFlow,
  'workflows/3_streams.ts': streams,
  'workflows/4_ai.ts': ai,
  'workflows/5_hooks.ts': hooks,
  'workflows/6_batching.ts': batching,
  'workflows/98_duplicate_case.ts': duplicate,
  'workflows/99_e2e.ts': e2e,
};
