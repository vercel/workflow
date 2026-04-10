// Default export of sync function should be allowed in "use step" files
export default function processData(input) {
  'use step';
  return input * 2;
}
