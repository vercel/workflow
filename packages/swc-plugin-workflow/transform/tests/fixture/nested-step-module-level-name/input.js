// A module-level declaration sharing a nested step's name is only treated as
// a step (in the manifest and in workflow mode) when it is itself a step.
const act = 1;

export async function shared() {
  "use step";
  return act;
}

async function localStep() {
  "use step";
  return 3;
}

const arrowStep = async () => {
  "use step";
  return 4;
};

export const exportedArrowStep = async () => {
  "use step";
  return 5;
};

export async function wf() {
  "use workflow";
  const act = async () => {
    "use step";
    return 1;
  };
  const shared = async () => {
    "use step";
    return 2;
  };
  const localStep = async () => {
    "use step";
    return 3;
  };
  const arrowStep = async () => {
    "use step";
    return 4;
  };
  const exportedArrowStep = async () => {
    "use step";
    return 5;
  };
  return (
    (await act()) +
    (await shared()) +
    (await localStep()) +
    (await arrowStep()) +
    (await exportedArrowStep())
  );
}
