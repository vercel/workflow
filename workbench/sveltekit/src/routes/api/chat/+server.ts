// THIS FILE IS JUST FOR TESTING HMR AS AN ENTRY NEEDS
// TO IMPORT THE WORKFLOWS TO DISCOVER THEM AND WATCH

import { json, type RequestHandler } from '@sveltejs/kit';
import * as workflows from '../../../workflows/3_streams';

export const POST: RequestHandler = async ({
  request,
}: {
  request: Request;
}) => {
  console.log(workflows);
  return json('hello world');
};
