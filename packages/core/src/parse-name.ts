/**
 * Parse a machine readable name.
 *
 * @see {@link ../../swc-plugin-workflow/transform/src/naming.rs} for the naming scheme.
 */
function parseName(
  tag: string,
  name: string
): { shortName: string; path: string; functionName: string } | null {
  if (typeof name !== 'string') {
    return null;
  }
  // Looks like {prefix}//{filepath}//{function_name}"
  // Where:
  // - {prefix} is either 'workflow' or 'step'
  // - {filepath} is the path to the file
  // - {function_name} is the name of the function
  const [prefix, path, ...functionNameParts] = name.split('//');
  if (prefix !== tag || !path || functionNameParts.length === 0) {
    return null;
  }

  let shortName = functionNameParts.at(-1) ?? '';
  const functionName = functionNameParts.join('//');
  const filename = path.split('/').at(-1) ?? '';
  const fileNameWithoutExtension = filename.split('.').at(0) ?? '';

  // Default exports will use the file name as the short name. "__default" was only
  // used for one package version, so this is a minor backwards compatibility fix.
  if (
    ['default', '__default'].includes(shortName) &&
    fileNameWithoutExtension
  ) {
    shortName = fileNameWithoutExtension;
  }

  return {
    shortName,
    path,
    functionName,
  };
}

/**
 * Parse a workflow name into its components.
 *
 * @param name - The workflow name to parse.
 * @returns An object with `shortName`, `path`, and `functionName` properties.
 * When the name is invalid, returns `null`.
 */
export function parseWorkflowName(name: string) {
  return parseName('workflow', name);
}

/**
 * Parse a step name into its components.
 *
 * @param name - The step name to parse.
 * @returns An object with `shortName`, `path`, and `functionName` properties.
 * When the name is invalid, returns `null`.
 */
export function parseStepName(name: string) {
  return parseName('step', name);
}
