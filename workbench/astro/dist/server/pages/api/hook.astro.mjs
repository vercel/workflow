import '../../chunks/index_ePTMDSOu.mjs';
import 'ms';
import '@jridgewell/sourcemap-codec';
import { g as getHookByToken, a as resumeHook } from '../../chunks/resume-hook_BHshEMMl.mjs';
export { renderers } from '../../renderers.mjs';

const POST = async ({ request }) => {
  const { token, data } = await request.json();
  let hook;
  try {
    hook = await getHookByToken(token);
    console.log("hook", hook);
  } catch (error) {
    console.log("error during getHookByToken", error);
    return Response.json(null, { status: 404 });
  }
  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData
  });
  return Response.json(hook);
};
const prerender = false;

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  POST,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
