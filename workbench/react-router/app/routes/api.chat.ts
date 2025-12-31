// THIS FILE IS JUST FOR TESTING HMR AS AN ENTRY NEEDS
// TO IMPORT THE WORKFLOWS TO DISCOVER THEM AND WATCH

import * as workflows from '../../workflows/3_streams';

export async function action() {
  console.log(workflows);
  return Response.json('hello world');
}
