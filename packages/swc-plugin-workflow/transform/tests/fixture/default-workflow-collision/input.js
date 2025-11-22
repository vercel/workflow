// Existing variable named __default
const __default = "existing variable";

// Use it to avoid unused variable
console.log(__default);

// Anonymous default export should get unique name (__default$1)
export default async function() {
  'use workflow';
  const result = await someStep();
  return result;
}

