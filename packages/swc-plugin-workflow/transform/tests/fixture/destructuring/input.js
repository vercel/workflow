export async function destructure({a, b}) {
  'use step';
  return a + b;
}

export async function process_array([first, second]) {
  'use step';
  return first + second;
}

export async function nested_destructure({user: {name, age}}) {
  'use step';
  return `${name} is ${age} years old`;
}

export async function with_defaults({x = 10, y = 20}) {
  'use step';
  return x + y;
}

export async function with_rest({a, b, ...rest}) {
  'use step';
  return {a, b, rest};
}

export async function multiple({a, b},{c, d}) {
  'use step';
  return {a, b, c, d};
}

export async function rest_top_level(a, b, ...rest) {
  'use step';
  return {a, b, rest};
}
