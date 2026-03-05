import { getPackageJson } from "./helper";
import { formatOutput } from "./utils";

export async function myStep() {
  "use step";
  return await getPackageJson();
}

export async function myOtherStep(data) {
  "use step";
  return formatOutput(data);
}
