// THIS FILE IS JUST FOR TESTING HMR AS AN ENTRY NEEDS
// TO IMPORT THE WORKFLOWS TO DISCOVER THEM AND WATCH

import type { APIRoute } from 'astro';
import * as workflows from '../../workflows/3_streams';

export const POST: APIRoute = async ({ request }: { request: Request }) => {
  console.log(workflows);
  return Response.json('hello world');
};

export const prerender = false;
