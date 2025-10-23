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
  const [prefix, path, ...functionNameParts] = name.split('//');
  if (prefix !== tag || !path || functionNameParts.length === 0) {
    return null;
  }

  return {
    shortName: functionNameParts.at(-1) ?? '',
    path,
    functionName: functionNameParts.join('//'),
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
