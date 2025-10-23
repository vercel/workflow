export async function __builtin_response_array_buffer(res: Response) {
  'use step';
  return res.arrayBuffer();
}

export async function __builtin_response_json(res: Response) {
  'use step';
  return res.json();
}

export async function __builtin_response_text(res: Response) {
  'use step';
  return res.text();
}
