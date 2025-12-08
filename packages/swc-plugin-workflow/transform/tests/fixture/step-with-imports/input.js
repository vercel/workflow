import { someHelper } from './helpers'; // removed in step/workflow mode, kept in client mode
import {
  anotherHelper, // removed in step/workflow mode, kept in client mode
  usefulHelper // always kept
} from './utils'; 
import defaultExport from './default'; // removed in step/workflow mode, kept in client mode
import * as something from './something'; // removed in step/workflow mode, kept in client mode
import * as useful from './useful'; // always kept
import 'dotenv/config' // removed in step/workflow mode, kept in client mode

export async function processData(data) {
  'use step';
  const result = someHelper(data);
  const transformed = anotherHelper(result);
  localFunction();
  return defaultExport(transformed);
}

function localFunction() {
  // only used by the step, so it should be removed
  // when the step body gets removed since it is not used
  // anywhere anymore
  something.doSomething();
}

export function normalFunction() {
  // since this function is exported we can't remove it
  useful.doSomething();
  return usefulHelper();
} 
