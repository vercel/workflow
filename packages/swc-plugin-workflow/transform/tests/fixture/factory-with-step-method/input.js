import fs from 'fs/promises';

const myFactory = () => ({
  myStep: async () => {
    'use step';
    await fs.mkdir('test');
  },
});

export default myFactory;

