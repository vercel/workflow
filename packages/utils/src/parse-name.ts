/**
 * Parse a machine readable name.
 *
 * @see {@link ../../swc-plugin-workflow/transform/src/naming.rs} for the naming scheme.
 */
function parseName(
  tag: string,
  name: string
): { shortName: string; moduleSpecifier: string; functionName: string } | null {
  if (typeof name !== 'string') {
    return null;
  }
  // Looks like {prefix}//{moduleSpecifier}//{function_name}"
  // Where:
  // - {prefix} is either 'workflow', 'step', or 'class'
  // - {moduleSpecifier} is either:
  //   - A module specifier (e.g., `point@0.0.1`, `@myorg/shared@1.2.3`) when provided via plugin config
  //   - A relative path prefixed with `./` (e.g., `./src/jobs/order`) when no specifier is provided
  // - {function_name} is the name of the function (with nested functions using `/` separators)
  const [prefix, moduleSpecifier, ...functionNameParts] = name.split('//');
  if (prefix !== tag || !moduleSpecifier || functionNameParts.length === 0) {
    return null;
  }

  const functionName = functionNameParts.join('//');
  // For nested functions like "processOrder/innerStep", get just "innerStep"
  let shortName = functionName.split('/').at(-1) ?? '';

  // Extract a reasonable name for default exports
  // For module specifiers like "point@0.0.1", use the package name "point"
  // For relative paths like "./src/jobs/order", use the last segment "order"
  let moduleShortName = '';
  if (moduleSpecifier.startsWith('./')) {
    // Relative path: use the last path segment
    moduleShortName = moduleSpecifier.split('/').at(-1) ?? '';
  } else {
    // Module specifier: extract package name (strip version and scope)
    // e.g., "@myorg/shared@1.2.3" -> "shared", "point@0.0.1" -> "point"
    const withoutVersion =
      moduleSpecifier.split('@').slice(0, -1).join('@') ||
      moduleSpecifier.split('@')[0];
    moduleShortName = withoutVersion?.split('/').at(-1) ?? '';
  }

  // Default exports will use the module short name. "__default" was only
  // used for one package version, so this is a minor backwards compatibility fix.
  if (['default', '__default'].includes(shortName) && moduleShortName) {
    shortName = moduleShortName;
  }

  return {
    shortName,
    moduleSpecifier,
    functionName,
  };
}

/**
 * Parse a workflow name into its components.
 *
 * @param name - The workflow name to parse (e.g., "workflow//./src/jobs/order//processOrder" or "workflow//mypackage@1.0.0//processOrder").
 * @returns An object with `shortName`, `moduleSpecifier`, and `functionName` properties.
 * When the name is invalid, returns `null`.
 */
export function parseWorkflowName(name: string) {
  return parseName('workflow', name);
}

/**
 * Parse a step name into its components.
 *
 * @param name - The step name to parse (e.g., "step//./src/jobs/order//fetchData" or "step//@myorg/tasks@2.0.0//processOrder").
 * @returns An object with `shortName`, `moduleSpecifier`, and `functionName` properties.
 * When the name is invalid, returns `null`.
 */
export function parseStepName(name: string) {
  return parseName('step', name);
}

/**
 * Parse a class ID into its components.
 *
 * @param name - The class ID to parse (e.g., "class//./src/models/Point//Point" or "class//point@0.0.1//Point").
 * @returns An object with `shortName`, `moduleSpecifier`, and `functionName` (className) properties.
 * When the name is invalid, returns `null`.
 */
export function parseClassName(name: string) {
  return parseName('class', name);
}

/**
 * Human-friendly single-line rendering of a step or workflow name for log
 * messages. Parses the machine name (`step//./workflows/1_simple//add`) and
 * renders it as `add (./workflows/1_simple)` so users see the short function
 * name and the source module specifier without the internal `//` syntax.
 *
 * Falls back to the raw name if parsing fails (e.g. older name formats or
 * user-provided strings we don't recognize) so logs never silently drop
 * information.
 */
export function formatStepName(name: string): string {
  return formatParsedName(parseStepName(name), name);
}

export function formatWorkflowName(name: string): string {
  return formatParsedName(parseWorkflowName(name), name);
}

function formatParsedName(
  parsed: {
    shortName: string;
    moduleSpecifier: string;
    functionName: string;
  } | null,
  fallback: string
): string {
  if (!parsed) return fallback;
  return `${parsed.shortName} (${parsed.moduleSpecifier})`;
}
