import { createClient } from '@supabase/supabase-js';

async function checkDatabase(userId: string) {
  'use step';

  const supabase = createClient(
    process.env.SUPABASE_URL || 'https://example.supabase.co',
    process.env.SUPABASE_KEY || 'example-key'
  );

  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  return data;
}

export async function GET(request: Request) {
  'use workflow';

  // This will cause the workflow bundle to try to bundle Supabase
  // which has Node.js built-ins
  const client = createClient('url', 'key');

  const user = await checkDatabase('test-user-id');
  return Response.json({ user, client });
}
