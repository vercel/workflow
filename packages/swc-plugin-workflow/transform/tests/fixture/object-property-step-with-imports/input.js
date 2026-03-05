import { something } from './somewhere';
import { sleep } from 'workflow';

const dude = {
  async myStep(a) {
    "use step";
    something();
    return a + 1;
  },
};

export async function main() {
  "use workflow";
  await sleep(1000);
  await dude.myStep(1);
  return "hello world";
}

dude.myStep();
