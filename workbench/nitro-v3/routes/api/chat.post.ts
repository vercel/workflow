// THIS FILE IS JUST FOR TESTING HMR AS AN ENTRY NEEDS
// TO IMPORT THE WORKFLOWS TO DISCOVER THEM AND WATCH

import * as workflows from '../../workflows/streams.js';

export default async ({ req }: { req: Request }) => {
  console.log(workflows);
  return Response.json('hello world');
};
