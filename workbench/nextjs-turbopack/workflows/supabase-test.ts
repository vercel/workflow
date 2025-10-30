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

export async function supabaseWorkflow(args: { userId: string }) {
  'use workflow';

  const user = await checkDatabase(args.userId);
  return { user };
}
