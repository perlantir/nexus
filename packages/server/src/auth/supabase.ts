/**
 * Supabase Auth client initialization.
 * Used for authentication operations (signup, login, verify JWT, etc.).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;

/**
 * Get the Supabase client (anon key — for client-facing auth operations).
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;

    if (!url || !anonKey) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_ANON_KEY are required when DECIGRAPH_AUTH_REQUIRED=true',
      );
    }

    supabaseClient = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return supabaseClient;
}

/**
 * Get the Supabase admin client (service role key — for server-side operations).
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!supabaseAdminClient) {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for admin operations',
      );
    }

    supabaseAdminClient = createClient(url, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return supabaseAdminClient;
}

/**
 * Check if Supabase auth is configured.
 */
export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}
