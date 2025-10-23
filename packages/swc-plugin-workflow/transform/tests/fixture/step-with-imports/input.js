import { someHelper } from './helpers'; // should be removed
import {
  anotherHelper, // should be removed
  usefulHelper // do not remove
} from './utils'; 
import defaultExport from './default'; // should be removed
import * as something from './something'; // should be removed
import * as useful from './useful'; // do not remove
import 'dotenv/config' // should be removed

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