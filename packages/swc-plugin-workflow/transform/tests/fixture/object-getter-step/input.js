export const config = {
  get timestamp() {
    'use step';
    return Date.now();
  },

  async process(data) {
    'use step';
    return data * 2;
  },
};
