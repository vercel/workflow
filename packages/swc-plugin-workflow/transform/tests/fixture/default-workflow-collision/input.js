// Existing variable named defaultWorkflow
const defaultWorkflow = "existing variable";

// Use it to avoid unused variable
console.log(defaultWorkflow);

// Anonymous default export should get unique name
export default async function() {
  'use workflow';
  const result = await someStep();
  return result;
}

