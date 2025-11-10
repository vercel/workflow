import { a as add } from '../../chunks/99_e2e_DTaFFPMr.mjs';
export { renderers } from '../../renderers.mjs';

async function POST({ request }) {
  const body = await request.json();
  const { x, y } = body;
  console.log(`Calling step function directly with x=${x}, y=${y}`);
  const result = await add(x, y);
  console.log(`add(${x}, ${y}) = ${result}`);
  return Response.json({ result });
}
const prerender = false;

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  POST,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
