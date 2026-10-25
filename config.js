// Conexión con el servidor (Supabase). Vacío = la app funciona solo en este móvil.
// En producción este fichero se genera con:  node scripts/gen-config.js  (lee SUPABASE_URL y SUPABASE_ANON_KEY)
// "legal": datos de quien ofrece Brigada (salen en los Términos y el aviso de privacidad). Rellenar antes de vender.
window.BRIGADA_CONFIG = window.BRIGADA_CONFIG || { supabaseUrl: '', supabaseAnonKey: '', legal: { razon: '', nif: '', direccion: '', email: '' } };
